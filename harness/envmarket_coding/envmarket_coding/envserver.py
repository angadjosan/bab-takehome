"""Async client for the grader's JSON-lines server (`entrypoints.serve`, e.g. `python -m grader.env serve`).

One request per stdin line ``{"id", "cmd": reset|step|grade|close|ping, ...}``, one response per
stdout line ``{"id", "ok", ...}``. Non-JSON stdout noise is ignored; stderr is kept (tail) for errors.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from .sandbox import Command, Sandbox

STREAM_LIMIT = 16 * 1024 * 1024


class EnvServerError(RuntimeError):
    pass


class EnvServer:
    def __init__(self, cmd: Command, sandbox: Sandbox) -> None:
        self.cmd, self.sandbox = cmd, sandbox
        self.proc: asyncio.subprocess.Process | None = None
        self.stderr = ""
        self._next = 0
        self._lock = asyncio.Lock()
        self._drain: asyncio.Task | None = None

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            *self.cmd.argv,
            cwd=self.cmd.cwd,
            env=self.cmd.env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=STREAM_LIMIT,
        )
        self._drain = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while chunk := await self.proc.stderr.read(4096):
            self.stderr = (self.stderr + chunk.decode(errors="replace"))[-4000:]

    async def call(self, req: dict, timeout: float = 180.0) -> dict:
        async with self._lock:
            if self.proc is None or self.proc.returncode is not None:
                raise EnvServerError(f"env server not running; stderr: {self.stderr[-500:]}")
            self._next += 1
            rid = self._next
            assert self.proc.stdin and self.proc.stdout
            self.proc.stdin.write((json.dumps({"id": rid, **req}) + "\n").encode())
            await self.proc.stdin.drain()

            async def read_reply() -> dict:
                while True:
                    line = await self.proc.stdout.readline()
                    if not line:
                        raise EnvServerError(f"env server exited ({self.proc.returncode}); stderr: {self.stderr[-500:]}")
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(msg, dict) and msg.get("id") == rid:
                        return msg

            try:
                return await asyncio.wait_for(read_reply(), timeout)
            except asyncio.TimeoutError as e:
                raise EnvServerError(f"env {req.get('cmd')} timed out after {timeout:g}s") from e

    async def close(self) -> None:
        if self.proc is None:
            return
        with contextlib.suppress(Exception):
            if self.proc.stdin:
                self.proc.stdin.close()
        try:
            await asyncio.wait_for(self.proc.wait(), 5)
        except (asyncio.TimeoutError, ProcessLookupError):
            await asyncio.to_thread(self.sandbox.kill, self.cmd)
            with contextlib.suppress(ProcessLookupError):
                self.proc.kill()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.proc.wait(), 10)
        if self._drain:
            self._drain.cancel()
        self.proc = None


async def run_once(cmd: Command, sandbox: Sandbox, timeout: float) -> tuple[int | None, str, str, bool]:
    """Run a one-shot sandboxed command; returns (exit code, stdout, stderr, timed out)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd.argv, cwd=cmd.cwd, env=cmd.env, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=STREAM_LIMIT
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout + (15 if cmd.container else 0))
        return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace"), False
    except asyncio.TimeoutError:
        await asyncio.to_thread(sandbox.kill, cmd)
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        out, err = await proc.communicate()
        return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace"), True

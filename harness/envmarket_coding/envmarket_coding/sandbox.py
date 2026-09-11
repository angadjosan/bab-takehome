"""Isolation for seller code (the env server, visible tests that import agent-written code, grading).

Same modes as the TEE runner (services/tee/src/sandbox.ts):

* ``docker`` -- one container per phase::

      docker run --rm -i --network none --read-only --tmpfs /tmp --tmpfs /work --cpus 1
        --memory 512m --pids-limit 128 --security-opt no-new-privileges --cap-drop ALL
        --user 65534:65534 -v <dirs> python:3.12-slim@sha256:... <venv>/bin/python ...

* ``unshare`` -- Linux, running as root (the in-TEE runtime)::

      [unshare --net --pid --fork --mount-proc --]   (when the kernel allows it)
      setpriv --reuid U --regid U --clear-groups --no-new-privs
      prlimit --as --nproc --nofile --fsize --cpu --
      [python3 <netdeny.py>]                          (seccomp net-deny launcher, --netdeny)
      env -i ... <venv>/bin/python ...

  Each phase gets its own unprivileged uid and its directories are chowned to it (0700), so one
  episode cannot read another's files. If neither a network namespace nor the seccomp launcher is
  available, the harness refuses to run.
* ``none`` -- no isolation (local development only; reported as such).

The grader's dependencies (the bundle's hash-pinned requirements.lock, binary wheels only) are
installed into a cached venv WITH network before any seller code runs; every later phase is offline.
"""

from __future__ import annotations

import hashlib
import itertools
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PY_IMAGE = "python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"
SANDBOX_KINDS = ("docker", "unshare", "none")
DOCKER_UID = 65534
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
BASE_ENV = {
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONHASHSEED": "0",
    "PYTHONUNBUFFERED": "1",
    "PYTHONNOUSERSITE": "1",
    "HOME": "/tmp",
    "TMPDIR": "/tmp",
    "TZ": "UTC",
    "LC_ALL": "C.UTF-8",
}


log = logging.getLogger(__name__)

# Run as a sandboxed phase uid by Sandbox.selftest(): it must not reach the network, and must not
# list or traverse any private dir passed as an argument (sys.argv[1:]).
_NET_PROBE = """
import os, socket, sys
r = []
try:
    socket.create_connection(("1.1.1.1", 443), timeout=5).close()
    r.append("tcp:OPEN")
except OSError as e:
    r.append("tcp:blocked(%s:%s)" % (type(e).__name__, e.errno))
try:
    socket.getaddrinfo("api.fireworks.ai", 443)
    r.append("dns:OPEN")
except OSError as e:
    r.append("dns:blocked(%s)" % type(e).__name__)
for i, p in enumerate(sys.argv[1:]):
    try:
        os.listdir(p)
        r.append("private%d:OPEN" % i)
    except OSError as e:
        r.append("private%d:blocked(%s)" % (i, type(e).__name__))
print(" ".join(r))
"""


class SandboxError(RuntimeError):
    pass


@dataclass
class Command:
    argv: list[str]
    cwd: str | None
    env: dict[str, str]
    container: str | None = None


def _ok(argv: list[str], timeout: float = 20) -> bool:
    try:
        return subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class Sandbox:
    def __init__(
        self,
        kind: str = "docker",
        image: str = DEFAULT_PY_IMAGE,
        netdeny: str | None = None,
        grader_python: str | None = None,
        memory_mb: int = 512,
        cpus: float = 1.0,
        pids: int = 128,
    ) -> None:
        if kind not in SANDBOX_KINDS:
            raise SandboxError(f"sandbox must be one of {SANDBOX_KINDS}")
        self.kind, self.image, self.memory_mb, self.cpus, self.pids = kind, image, memory_mb, cpus, pids
        self.grader_python = grader_python or shutil.which("python3.12") or shutil.which("python3") or "python3"
        self.netdeny = str(Path(netdeny).resolve()) if netdeny else None
        self.netdeny_error: str | None = None
        self.unshare_net = False
        self._uids = itertools.count(1)
        if kind == "docker":
            if not shutil.which("docker") or not _ok(["docker", "info", "--format", "{{.ServerVersion}}"]):
                raise SandboxError("sandbox docker: docker is not available")
        elif kind == "unshare":
            if platform.system() != "Linux" or os.geteuid() != 0:
                raise SandboxError("sandbox unshare requires running as root on Linux")
            for b in ("setpriv", "prlimit", "env"):
                if not shutil.which(b):
                    raise SandboxError(f"sandbox unshare: {b} not found")
            self.unshare_net = bool(shutil.which("unshare")) and _ok(["unshare", "--net", "--pid", "--fork", "--mount-proc", "true"])
            seccomp = False
            if self.netdeny:
                probe = "import socket\ntry:\n socket.socket(socket.AF_INET)\n print('OPEN')\nexcept OSError:\n print('DENIED')"
                r = subprocess.run(["python3", self.netdeny, "python3", "-c", probe], capture_output=True, text=True, timeout=20)
                seccomp = r.stdout.strip() == "DENIED"
                if not seccomp:
                    self.netdeny_error = (r.stdout.strip() or r.stderr.strip())[:200]
                    if not self.unshare_net:
                        raise SandboxError(f"sandbox unshare: --netdeny launcher did not deny sockets ({self.netdeny_error}) and there is no network namespace; refusing to run seller code with network")
                    # The network namespace (unshare --net) is the primary barrier; a launcher that cannot
                    # install its filter adds nothing, so it is dropped (and reported) instead of failing
                    # every episode. selftest() proves the barrier with a real connect attempt.
                    log.warning("--netdeny launcher unusable (%s); relying on the network namespace", self.netdeny_error)
                    self.netdeny = None
            if not self.unshare_net and not seccomp:
                raise SandboxError("sandbox unshare: no network namespace (unshare --net failed) and no --netdeny seccomp launcher; refusing to run seller code with network")

    # ------------------------------------------------------------------ reporting
    def describe(self) -> str:
        if self.kind == "docker":
            return (
                f"docker {self.image} --network none --read-only --tmpfs /tmp --tmpfs /work --cpus {self.cpus:g} "
                f"--memory {self.memory_mb}m --pids-limit {self.pids} --security-opt no-new-privileges --cap-drop ALL, uid {DOCKER_UID}"
            )
        if self.kind == "unshare":
            parts = [
                "unshare(net,pid)" if self.unshare_net else None,
                "setpriv(per-phase uid, no_new_privs)",
                "prlimit(as,nproc,nofile,fsize,cpu)",
                "seccomp net-deny" if self.netdeny else None,
            ]
            return "linux-root: " + " + ".join(p for p in parts if p)
        return "none: NO ISOLATION (local development only)"

    # ------------------------------------------------------------------ filesystem layout
    def check_layout(self, traversable: list[Path], private: list[Path]) -> None:
        """unshare mode has no mount namespace: sandboxed uids see the host filesystem. So the
        scratch root and grader venv must be traversable by them, and the bundle / audit dirs
        (hidden tests, solutions) must NOT be: some ancestor must deny others (no o+x)."""
        if self.kind != "unshare":
            return

        def others_can_traverse(p: Path) -> bool:
            p = Path(p).resolve()
            return all(os.stat(c).st_mode & 0o001 for c in [p, *p.parents])

        for p in traversable:
            if not others_can_traverse(p):
                raise SandboxError(f"{p} must be traversable by the sandbox uids (o+x on it and every parent)")
        for p in private:
            if Path(p).exists() and others_can_traverse(p):
                raise SandboxError(
                    f"{p} is reachable by sandboxed code (unshare mode has no mount namespace); keep bundles and audit tasks under a root-only (0700) directory"
                )

    # ------------------------------------------------------------------ uids / permissions
    def next_uid(self) -> int:
        return DOCKER_UID if self.kind != "unshare" else 40000 + next(self._uids) % 20000

    def prepare_root(self, path: Path) -> Path:
        """Create a harness-owned directory that sandboxed uids may traverse but not list."""
        path.mkdir(parents=True, exist_ok=True)
        if self.kind == "unshare":
            os.chmod(path, 0o711)
        return path

    def grant(self, root: Path, uid: int, writable: bool) -> None:
        """unshare: writable -> owned by uid (0700/0600); read-only -> owned by root, group uid
        (0750/0640): the phase uid reads through its group but cannot write, other uids see nothing,
        and copies the phase makes (e.g. the grader materializing a workspace) are its own and
        writable. docker/none: world-readable (and writable if requested) for the container uid."""
        if self.kind == "unshare":
            owner, dmode, fmode = (uid, 0o700, 0o600) if writable else (0, 0o750, 0o640)
            for dirpath, dirnames, filenames in os.walk(root):
                os.chown(dirpath, owner, uid)
                os.chmod(dirpath, dmode)
                for f in filenames:
                    p = os.path.join(dirpath, f)
                    if os.path.islink(p):
                        continue
                    os.chown(p, owner, uid)
                    os.chmod(p, fmode | (os.stat(p).st_mode & 0o100 and 0o110))
            return
        dmode, fmode = (0o777, 0o666) if writable else (0o755, 0o644)
        for dirpath, dirnames, filenames in os.walk(root):
            os.chmod(dirpath, dmode)
            for f in filenames:
                p = os.path.join(dirpath, f)
                if not os.path.islink(p):
                    os.chmod(p, fmode | (os.stat(p).st_mode & 0o111))

    # ------------------------------------------------------------------ commands
    def command(
        self,
        venv: Path,
        args: list[str],
        cwd: Path,
        read_dirs: list[Path],
        write_dirs: list[Path],
        uid: int,
        timeout_sec: float,
        extra_env: dict[str, str] | None = None,
    ) -> Command:
        py = str(Path(venv) / "bin" / "python")
        env = {**BASE_ENV, "PATH": f"{Path(venv) / 'bin'}:{SYSTEM_PATH}", **(extra_env or {})}
        if self.kind == "docker":
            name = f"envm-h-{os.getpid()}-{uuid.uuid4().hex[:10]}"
            argv = [
                "docker", "run", "--rm", "-i", "--name", name,
                "--network", "none", "--read-only",
                "--tmpfs", "/tmp:rw,exec,size=128m", "--tmpfs", "/work:rw,exec,size=256m",
                "--cpus", f"{self.cpus:g}", "--memory", f"{self.memory_mb}m", "--pids-limit", str(self.pids),
                "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
                "--user", f"{uid}:{uid}", "-w", str(cwd),
            ]
            seen: set[str] = set()
            for d, mode in [(d, "rw") for d in write_dirs] + [(d, "ro") for d in [*read_dirs, Path(venv)]]:
                if str(d) not in seen:
                    seen.add(str(d))
                    argv += ["-v", f"{d}:{d}:{mode}"]
            for k, v in env.items():
                argv += ["-e", f"{k}={v}"]
            argv += [self.image, py, *args]
            return Command(argv, None, dict(os.environ), name)
        if self.kind == "unshare":
            inner = [
                "setpriv", f"--reuid={uid}", f"--regid={uid}", "--clear-groups", "--no-new-privs",
                "prlimit", f"--as={self.memory_mb * 2 * 1024 * 1024}", "--nproc=256", "--nofile=512",
                f"--fsize={64 * 1024 * 1024}", f"--cpu={int(timeout_sec) + 5}", "--",
                *(["python3", self.netdeny] if self.netdeny else []),
                "env", "-i", *[f"{k}={v}" for k, v in env.items()], py, *args,
            ]
            argv = ["unshare", "--net", "--pid", "--fork", "--mount-proc", "--", *inner] if self.unshare_net else inner
            return Command(argv, str(cwd), {"PATH": SYSTEM_PATH})
        return Command([py, *args], str(cwd), env)

    def kill(self, cmd: Command) -> None:
        if cmd.container:
            _ok(["docker", "kill", cmd.container], timeout=15)

    def selftest(self, work_root: Path, private: list[Path] | None = None, timeout_sec: float = 30) -> dict:
        """Prove the barrier: run a probe as a fresh phase uid through the same command wrapper that
        episodes and graders use (unshare/setpriv/prlimit[/netdeny] or docker) and require that it cannot
        open a TCP connection. `private` are directories created the way the caller creates bundle /
        audit dirs (the TEE passes a canary made by its own openBundle code path): they must pass the
        same check_layout() the grader runs (raises SandboxError otherwise), and in unshare mode the
        probe must also fail to list them. Returns {ok, network, layout, probe, exit, stderr}; runs no
        seller code."""
        private = [Path(p).resolve() for p in (private or [])]
        for p in private:
            if not p.is_dir():
                raise SandboxError(f"selftest private dir {p} does not exist")
        root = self.prepare_root(Path(work_root))
        self.check_layout([root], private)
        d = Path(tempfile.mkdtemp(prefix="selftest-", dir=root))
        try:
            uid = self.next_uid()
            self.grant(d, uid, True)
            # docker: private dirs are not mounted, so the probe (correctly) cannot see them either
            cmd = self.command(Path(sys.prefix), ["-c", _NET_PROBE, *[str(p) for p in private]], d, [], [d], uid, timeout_sec)
            r = subprocess.run(cmd.argv, cwd=cmd.cwd, env=cmd.env, capture_output=True, text=True, timeout=timeout_sec + 30)
            out = r.stdout.strip()
            net_ok = r.returncode == 0 and out.startswith("tcp:") and "tcp:OPEN" not in out
            layout_ok = r.returncode == 0 and ":OPEN" not in out.replace("tcp:OPEN", "").replace("dns:OPEN", "")
            return {
                "ok": net_ok and layout_ok,
                "network": "open" if "tcp:OPEN" in out else ("blocked" if net_ok else "unknown"),
                "layout": {"ok": layout_ok, "private": len(private)},
                "probe": out[:300],
                "exit": r.returncode,
                "stderr": r.stderr.strip()[-300:],
            }
        finally:
            shutil.rmtree(d, ignore_errors=True)

    # ------------------------------------------------------------------ grader venv
    def prepare_venv(self, cache_root: Path, requirements_lock: bytes) -> Path:
        """Install the bundle's pinned grader deps (binary wheels only; --require-hashes when the lock
        has hashes). Runs no seller code. Cached by sha256(sandbox kind | image | lock)."""
        key = hashlib.sha256(f"{self.kind}|{self.image if self.kind == 'docker' else self.grader_python}|".encode() + requirements_lock).hexdigest()[:16]
        cache_root = self.prepare_root(Path(cache_root))
        venv = cache_root / f"venv-{key}"
        if (venv / ".ok").is_file():
            return venv
        shutil.rmtree(venv, ignore_errors=True)
        venv.mkdir(parents=True)
        (venv / "requirements.lock").write_bytes(requirements_lock)
        hashes = "--require-hashes" if b"--hash=sha256:" in requirements_lock else ""
        pip = f"{venv}/bin/pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: {hashes} -r {venv}/requirements.lock"
        if self.kind == "docker":
            argv = ["docker", "run", "--rm", "-v", f"{venv}:{venv}:rw", self.image, "sh", "-c", f"set -e; python3 -m venv {venv}; {pip}"]
        else:
            argv = ["sh", "-c", f"set -e; {self.grader_python} -m venv {venv}; {pip}"]
        r = subprocess.run(argv, capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise SandboxError(f"grader venv install failed: {(r.stdout + r.stderr)[-2000:]}")
        for dirpath, _, filenames in os.walk(venv):
            os.chmod(dirpath, os.stat(dirpath).st_mode | 0o555)
            for f in filenames:
                p = os.path.join(dirpath, f)
                if not os.path.islink(p):
                    os.chmod(p, os.stat(p).st_mode | 0o444)
        (venv / ".ok").write_text("ok\n")
        return venv

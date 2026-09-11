"""Digests that bind a report to the exact harness.

* harness_digest = sha256 of the canonical ustar archive of harness/envmarket_coding (source +
  pyproject + uv.lock + requirements.lock). Same canonical form as packages/shared/src/tar.ts
  (BUILD_SPEC "Canonical archive": entries sorted byte-wise, implied parents, mtime/uid/gid 0,
  empty uname/gname, mode 0644 / 0755, ASCII paths, no PAX, two zero blocks; headers encoded like
  tar-stream 3.x), with the default excludes (.DS_Store, __pycache__, .pytest_cache, .mypy_cache,
  .git) plus .venv and .ruff_cache. So `canonicalTarHashOfDir(dir, {excludeNames:
  [...DEFAULT_EXCLUDE_NAMES, '.venv', '.ruff_cache']})` in TypeScript gives the same value.
* prompt_digest = sha256(canonical JSON of {system, nudge, userTemplate}).
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path

HARNESS_ID = "envmarket.harness.verifiers.v1"
HARNESS_DIR = Path(__file__).resolve().parent.parent
EXCLUDE_NAMES = (".DS_Store", "__pycache__", ".pytest_cache", ".mypy_cache", ".git", ".venv", ".ruff_cache")
BLOCK = 512


def canonical_json(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(data: str | bytes) -> str:
    return "0x" + hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def _oct(value: int, digits: int) -> bytes:
    """tar-stream's encodeOct: `digits` zero-padded octal digits followed by one space."""
    s = format(value, "o")
    if len(s) > digits:
        raise ValueError(f"tar: numeric field overflow ({value})")
    return (s.rjust(digits, "0") + " ").encode()


def _split_name(name: str) -> tuple[str, str]:
    """tar-stream's ustar split: move leading path segments into `prefix` until name <= 100 bytes."""
    if not name.isascii():
        raise ValueError(f"tar: non-ASCII path not representable in plain ustar: {name!r}")
    prefix = ""
    while len(name) > 100:
        i = name.find("/")
        if i == -1:
            raise ValueError(f"tar: path too long for ustar: {name!r}")
        prefix = f"{prefix}/{name[:i]}" if prefix else name[:i]
        name = name[i + 1 :]
    if len(prefix) > 155:
        raise ValueError(f"tar: path too long for ustar: {prefix}/{name}")
    return name, prefix


def _header(name: str, is_dir: bool, mode: int, size: int) -> bytes:
    """One 512-byte ustar header, byte-identical to tar-stream 3.x `headers.encode` (the codec behind
    packages/shared/src/tar.ts): mtime 0, uid/gid 0, empty uname/gname/linkname, devmajor/minor 0."""
    h = bytearray(BLOCK)
    n, prefix = _split_name(name)
    h[0 : len(n)] = n.encode()
    h[100:107] = _oct(mode & 0o7777, 6)
    h[108:115] = _oct(0, 6)
    h[116:123] = _oct(0, 6)
    h[124:136] = _oct(size, 11)
    h[136:148] = _oct(0, 11)
    h[156] = 0x35 if is_dir else 0x30
    h[257:263] = b"ustar\0"
    h[263:265] = b"00"
    h[329:336] = _oct(0, 6)
    h[337:344] = _oct(0, 6)
    h[345 : 345 + len(prefix)] = prefix.encode()
    checksum = 8 * 0x20 + sum(h[:148]) + sum(h[156:])
    h[148:155] = _oct(checksum, 6)
    return bytes(h)


def canonical_tar(root: Path, exclude_names: tuple[str, ...] = EXCLUDE_NAMES) -> bytes:
    entries: list[tuple[bytes, str, bool, int, bytes]] = []

    def walk(abs_dir: Path, rel_dir: str) -> None:
        for name in sorted(os.listdir(abs_dir)):
            if name in exclude_names:
                continue
            p = abs_dir / name
            rel = f"{rel_dir}/{name}" if rel_dir else name
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                raise ValueError(f"tar: symlink not allowed: {rel}")
            if stat.S_ISDIR(st.st_mode):
                entries.append((rel.encode(), rel + "/", True, 0o755, b""))
                walk(p, rel)
            elif stat.S_ISREG(st.st_mode):
                entries.append((rel.encode(), rel, False, 0o755 if st.st_mode & 0o111 else 0o644, p.read_bytes()))
            else:
                raise ValueError(f"tar: special file not allowed: {rel}")

    walk(Path(root), "")
    out = bytearray()
    for _, name, is_dir, mode, data in sorted(entries, key=lambda e: e[0]):
        out += _header(name, is_dir, mode, len(data))
        if data:
            out += data + b"\0" * (-len(data) % BLOCK)
    out += b"\0" * (2 * BLOCK)
    return bytes(out)


def harness_digest(root: Path = HARNESS_DIR) -> str:
    return sha256_hex(canonical_tar(root))


def prompt_digest() -> str:
    from .prompt import NUDGE, SYSTEM_PROMPT, USER_TEMPLATE

    return sha256_hex(canonical_json({"system": SYSTEM_PROMPT, "nudge": NUDGE, "userTemplate": USER_TEMPLATE}))

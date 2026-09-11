"""Parse .env files into a dict of strings (for use with buildkit.config.interpolate).

    # comment lines and blank lines are ignored
    export API_URL=https://api.example.com   "export " before the key is optional
    NAME = value                             whitespace around the key and after "=" is ignored

Keys match [A-Za-z_][A-Za-z0-9_]*. Values:
  * unquoted: trailing whitespace is stripped. A "#" preceded by whitespace starts a comment that
    runs to the end of the line. Any other "#" is part of the value (COLOR=#fff, URL=a#b).
  * single-quoted: taken literally up to the next "'" (no escapes, "#" kept).
  * double-quoted: up to the next unescaped '"'. The escapes \\n, \\t, \\" and \\\\ are decoded; a
    backslash before any other character is kept as is. "#" is kept.
  After a closing quote, only whitespace or a comment may follow.
A later assignment to the same key wins. A malformed line raises DotenvError, and the message
starts with "line <n>:" (1-based).
"""

from __future__ import annotations

import re
from pathlib import Path

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_TAIL = re.compile(r"^\s*(?:#.*)?$")
_COMMENT = re.compile(r"\s#")
_ESCAPES = {"n": "\n", "t": "\t", '"': '"', "\\": "\\"}


class DotenvError(ValueError):
    pass


def _double_quoted(raw: str, lineno: int) -> tuple[str, str]:
    out, i = [], 1
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            out.append(_ESCAPES.get(nxt, "\\" + nxt))
            i += 2
            continue
        if c == '"':
            return "".join(out), raw[i + 1:]
        out.append(c)
        i += 1
    raise DotenvError(f"line {lineno}: unterminated double-quoted value")


def parse_dotenv(text: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _LINE.match(line)
        if not m:
            raise DotenvError(f"line {lineno}: expected KEY=VALUE")
        key, raw = m.group(1), m.group(2)
        rest = ""
        if raw.startswith("'"):
            end = raw.find("'", 1)
            if end < 0:
                raise DotenvError(f"line {lineno}: unterminated single-quoted value")
            value, rest = raw[1:end], raw[end + 1:]
        elif raw.startswith('"'):
            value, rest = _double_quoted(raw, lineno)
        else:
            hit = _COMMENT.search(raw)
            value = (raw[:hit.start()] if hit else raw).rstrip()
        if not _TAIL.match(rest):
            raise DotenvError(f"line {lineno}: unexpected text after the closing quote")
        env[key] = value
    return env


def load_dotenv(path: str | Path) -> dict[str, str]:
    return parse_dotenv(Path(path).read_text(encoding="utf-8-sig"))

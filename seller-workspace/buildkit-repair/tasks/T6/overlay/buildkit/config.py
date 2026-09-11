"""Layered configuration: deep merge with precedence, then ${VAR} interpolation.

merge_layers(*layers) combines mappings from left to right; later layers take precedence:
  * when both sides hold a mapping under the same key, the two are merged recursively;
  * in every other case (lists, scalars, None, a mapping replacing a non-mapping or the reverse)
    the later layer's value replaces the earlier one. Lists are replaced, never concatenated.
  The result is a new dict made of plain dicts and lists. No input layer is ever modified, and the
  result shares no mutable object with any layer, so changing one never changes the other.

interpolate(config, env) returns a new config in which every string value, including strings
inside nested dicts and lists (keys are left alone), is expanded from the `env` mapping:
    ${NAME}             the value of NAME; ConfigError if NAME is not in env
    ${NAME:-default}    the value of NAME if it is set and non-empty, else the literal default
    $$                  a literal "$"
  Expansion is a single pass: text inserted from env or from a default is not expanded again. A "$"
  that does not start one of the forms above is kept as is. Non-string values are unchanged. The
  ConfigError message names the variable and the dotted path of the value ("database.url";
  list items use their index, as in "servers.1.host").

load(layers, env) is interpolate(merge_layers(*layers), env).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

_REF = re.compile(r"\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\})")


class ConfigError(ValueError):
    pass


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _merge(base: dict, override: Mapping) -> dict:
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value if isinstance(value, dict) else _plain(value)
    return base


def merge_layers(*layers: Mapping) -> dict:
    result: dict = {}
    for layer in layers:
        if not isinstance(layer, Mapping):
            raise ConfigError(f"a layer must be a mapping, got {type(layer).__name__}")
        result = _merge(result, layer)
    return result


def _expand(text: str, env: Mapping[str, str], path: str) -> str:
    def repl(m: re.Match) -> str:
        if m.group(0) == "$$":
            return "$"
        name, default = m.group(1), m.group(2)
        if default is not None:
            return env.get(name) or default
        if name not in env:
            raise ConfigError(f"undefined variable {name} in {path or '<root>'}")
        return str(env[name])

    return _REF.sub(repl, text)


def interpolate(config: Any, env: Mapping[str, str], _path: str = "") -> Any:
    join = (lambda k: f"{_path}.{k}" if _path else str(k))
    if isinstance(config, Mapping):
        return {k: interpolate(v, env, join(k)) for k, v in config.items()}
    if isinstance(config, (list, tuple)):
        return [interpolate(v, env, join(i)) for i, v in enumerate(config)]
    if isinstance(config, str):
        return _expand(config, env, _path)
    return config


def load(layers: Iterable[Mapping], env: Mapping[str, str]) -> dict:
    return interpolate(merge_layers(*layers), env)

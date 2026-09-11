"""A seller bundle as the harness sees it: manifest, declared actions (-> tools), tasks, kits.

The environment defines the interface. Tool definitions are generated from the manifest's declared
action schema, never hard-coded here:

* preferred: ``schemas["action.jsonSchema"]`` -- a JSON Schema ``oneOf`` discriminated by
  ``discriminator.propertyName`` (default ``type``). Each branch becomes one tool: name = the
  discriminator ``const``, description = the branch ``description``, arguments = the branch's
  other properties. ``x-terminal`` marks the action that ends the episode, and
  ``x-countsAgainstBudget`` says whether it uses one of the ``actionBudget`` actions.
* fallback (older bundles): the loose ``schemas["action"]["oneOf"]`` notation, e.g.
  ``{"type": "read_file", "path": "string"}`` or ``"string? (default '.')"``. Here ``submit`` is
  assumed to be the terminal, budget-free action.

Entrypoints come from the manifest too (``entrypoints.serve`` and ``entrypoints.gradeArtifact``;
the packager moves the argv objects to ``entrypoints.spec``, which is read first).
"""

from __future__ import annotations

import json
import re
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .digest import canonical_json, sha256_hex

ACTION_JSON_SCHEMA_KEY = "action.jsonSchema"
TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PYTHON_NAMES = ("python", "python3", "python3.12")
SPLITS = ("purchased", "audit")
IGNORE_NAMES = {"__pycache__", ".pytest_cache", ".DS_Store"}


class BundleError(ValueError):
    pass


@dataclass(frozen=True)
class ActionTool:
    name: str
    description: str
    parameters: dict[str, Any]
    arg_names: tuple[str, ...]
    terminal: bool
    counts_against_budget: bool

    def definition(self) -> dict[str, Any]:
        """Provider-agnostic tool definition (verifiers `vf.Tool` / OpenAI function shape)."""
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


_LOOSE_RE = re.compile(r"^\s*(string|int|integer|number|float|bool|boolean)(\[\])?(\?)?\s*(?:\((.*)\))?\s*$")
_LOOSE_TYPES = {"string": "string", "int": "integer", "integer": "integer", "number": "number", "float": "number", "bool": "boolean", "boolean": "boolean"}


def _budget_note(terminal: bool, counts: bool) -> str:
    if terminal:
        return " Ends the episode; you cannot act afterwards." + ("" if counts else " Does not use the action budget.")
    return " Uses one action from the budget." if counts else " Does not use the action budget."


def _tool(name: str, description: str, props: dict, required: list[str], terminal: bool, counts: bool) -> ActionTool:
    if not TOOL_NAME_RE.match(name):
        raise BundleError(f"manifest action name {name!r} is not a valid tool name")
    parameters = {"type": "object", "properties": props, "required": required, "additionalProperties": False}
    return ActionTool(name, description.strip() + _budget_note(terminal, counts), parameters, tuple(props), terminal, counts)


def tools_from_json_schema(schema: dict) -> tuple[str, list[ActionTool]]:
    disc = (schema.get("discriminator") or {}).get("propertyName", "type")
    branches = schema.get("oneOf")
    if not isinstance(branches, list) or not branches:
        raise BundleError(f"schemas[{ACTION_JSON_SCHEMA_KEY!r}] needs a non-empty oneOf")
    tools = []
    for b in branches:
        props = dict(b.get("properties") or {})
        tag = props.pop(disc, None)
        if not isinstance(tag, dict) or not isinstance(tag.get("const"), str):
            raise BundleError(f"every action branch needs properties.{disc}.const")
        name = tag["const"]
        terminal = bool(b.get("x-terminal", False))
        counts = bool(b.get("x-countsAgainstBudget", not terminal))
        required = [r for r in b.get("required", []) if r != disc]
        tools.append(_tool(name, b.get("description") or b.get("title") or name, props, required, terminal, counts))
    return disc, tools


def tools_from_loose(entries: list) -> tuple[str, list[ActionTool]]:
    tools = []
    for e in entries:
        if not isinstance(e, dict) or not isinstance(e.get("type"), str):
            raise BundleError("loose action entries need a string 'type'")
        name = e["type"]
        props, required = {}, []
        for key, spec in e.items():
            if key == "type":
                continue
            m = _LOOSE_RE.match(str(spec))
            if not m:
                raise BundleError(f"cannot read loose action field {name}.{key}: {spec!r}")
            base, is_list, optional, desc = m.groups()
            js: dict[str, Any] = {"type": _LOOSE_TYPES[base]}
            if is_list:
                js = {"type": "array", "items": js}
            if desc:
                js["description"] = desc
            props[key] = js
            if not optional:
                required.append(key)
        terminal = name == "submit"
        tools.append(_tool(name, f"Environment action {name!r}.", props, required, terminal, not terminal))
    return "type", tools


def entrypoint_argv(manifest: dict, name: str) -> list[str]:
    eps = manifest.get("entrypoints") or {}
    spec = eps.get("spec") if isinstance(eps.get("spec"), dict) else {}
    for src in (spec.get(name), eps.get(name)):
        if isinstance(src, dict) and isinstance(src.get("argv"), list):
            return [str(a) for a in src["argv"]]
        if isinstance(src, list):
            return [str(a) for a in src]
        if isinstance(src, str) and src.strip():
            return shlex.split(src)
    raise BundleError(f"manifest declares no entrypoints.{name}")


class Bundle:
    """A purchased payload directory (manifest.json at the root, or a seller workspace whose
    manifest is still listing/manifest.template.json). Audit tasks live in `audit_dir`
    (default: <root>/audit-tasks)."""

    def __init__(self, root: str | Path, audit_dir: str | Path | None = None) -> None:
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise BundleError(f"bundle dir not found: {self.root}")
        self.audit_dir = Path(audit_dir).resolve() if audit_dir else self.root / "audit-tasks"
        for rel in ("manifest.json", "listing/manifest.template.json"):
            p = self.root / rel
            if p.is_file():
                self.manifest: dict = json.loads(p.read_text(encoding="utf-8"))
                self.manifest_source = rel
                break
        else:
            raise BundleError(f"no manifest.json (or listing/manifest.template.json) in {self.root}")
        schemas = self.manifest.get("schemas") or {}
        if isinstance(schemas.get(ACTION_JSON_SCHEMA_KEY), dict):
            self.discriminator, self.tools = tools_from_json_schema(schemas[ACTION_JSON_SCHEMA_KEY])
            self.tool_source = f"schemas.{ACTION_JSON_SCHEMA_KEY}"
        elif isinstance(schemas.get("action"), dict) and isinstance(schemas["action"].get("oneOf"), list):
            self.discriminator, self.tools = tools_from_loose(schemas["action"]["oneOf"])
            self.tool_source = "schemas.action (loose notation)"
        else:
            raise BundleError("manifest declares no action schema")
        if sum(t.terminal for t in self.tools) != 1:
            raise BundleError("the manifest must declare exactly one terminal action")
        self.tool_by_name = {t.name: t for t in self.tools}
        self.environment_id = self.manifest.get("environmentId") or self.root.name
        self.environment_version = self.manifest.get("environmentVersion")

    @property
    def terminal_tool(self) -> ActionTool:
        return next(t for t in self.tools if t.terminal)

    def tool_definitions(self) -> list[dict]:
        return [t.definition() for t in self.tools]

    def tools_digest(self) -> str:
        return sha256_hex(canonical_json(self.tool_definitions()))

    def task_root(self, split: str) -> Path:
        if split not in SPLITS:
            raise BundleError(f"split must be one of {SPLITS}")
        return self.root / "tasks" if split == "purchased" else self.audit_dir

    def task_ids(self, split: str) -> list[str]:
        if split == "purchased" and isinstance(self.manifest.get("taskIds"), list):
            return [str(t) for t in self.manifest["taskIds"]]
        root = self.task_root(split)
        return sorted(p.name for p in root.iterdir() if (p / "task.json").is_file()) if root.is_dir() else []

    def requirements_lock(self) -> bytes:
        p = self.root / "requirements.lock"
        if not p.is_file():
            raise BundleError(f"no requirements.lock in {self.root}")
        return p.read_bytes()

    def python_args(self, entrypoint: str, values: dict[str, str]) -> list[str]:
        """Entrypoint argv after the interpreter, with {placeholders} filled."""
        argv = entrypoint_argv(self.manifest, entrypoint)
        if not argv or Path(argv[0]).name not in PYTHON_NAMES:
            raise BundleError(f"entrypoints.{entrypoint} must start with python, got {argv[:1]}")
        out = []
        for a in argv[1:]:
            for k, v in values.items():
                a = a.replace("{" + k + "}", v)
            if re.search(r"\{[A-Za-z]+\}", a):
                raise BundleError(f"entrypoints.{entrypoint}: unfilled placeholder in {a!r}")
            out.append(a)
        return out


def _task_spec(task_dir: Path) -> dict:
    p = task_dir / "task.json"
    if not p.is_file():
        raise BundleError(f"task not found: {task_dir}")
    return json.loads(p.read_text(encoding="utf-8"))


def build_kit(scratch: Path, bundle: Bundle, split: str, task_id: str, with_hidden: bool) -> Path:
    """Copy the minimum the grader needs into <scratch>/(kit|gradekit): src/, grader/ and ONLY this
    task. The agent kit omits the task's hidden tests and any reference solution, so code the agent
    writes (which runs during visible tests) can never read them."""
    kit = scratch / ("gradekit" if with_hidden else "kit")
    ignore = shutil.ignore_patterns(*IGNORE_NAMES)
    shutil.copytree(bundle.root / "src", kit / "src", ignore=ignore)
    shutil.copytree(bundle.root / "grader", kit / "grader", ignore=ignore)
    src = bundle.task_root(split) / task_id
    spec = _task_spec(src)
    hidden = str(spec.get("hiddenTestsDir", "tests/")).strip("/").split("/")[0]
    drop_top = {"solution"} if with_hidden else {"solution", hidden}

    def task_ignore(directory: str, names: list[str]) -> set[str]:
        top = Path(directory).resolve() == src.resolve()
        return {n for n in names if n in IGNORE_NAMES or (top and n in drop_top)}

    shutil.copytree(src, kit / "tasks" / task_id, ignore=task_ignore)
    return kit

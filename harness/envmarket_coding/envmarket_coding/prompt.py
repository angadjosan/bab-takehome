"""Everything the model is shown besides task data and the manifest-generated tools.

`prompt_digest` (see digest.py) is sha256 over the canonical JSON of SYSTEM_PROMPT, NUDGE and
USER_TEMPLATE; the tools are bound separately per bundle by `toolsDigest`.
"""

from __future__ import annotations

SYSTEM_PROMPT = " ".join(
    [
        "You are a software engineer repairing a bug in a small Python repository.",
        "You can only act through the provided tools; the environment defines them and their budget rules.",
        "Writing a file replaces the whole file, so always send the complete new file content.",
        "Every tool call except submit uses one action from a limited budget; when the budget is used up, only submit is accepted.",
        "The episode ends when you call submit and you cannot continue afterwards. A hidden test suite then grades your final workspace.",
        "Work efficiently: read the relevant code, make a minimal correct fix that keeps the public API unchanged, run the visible tests, then submit.",
    ]
)

NUDGE = "Continue by calling one of the tools. Call submit when your fix is complete."

USER_TEMPLATE = (
    "Task: {title}\n"
    "\n"
    "{statement}\n"
    "\n"
    "Workspace files:\n"
    "{files}\n"
    "\n"
    "Editable files (glob patterns): {editable}\n"
    "Visible test command: {visibleTestCmd}\n"
    "Budget: {actionBudget} tool actions ({terminal} is free); {timeBudgetSec} seconds wall clock."
)


def render_task_message(obs: dict, terminal_tool: str) -> str:
    """The first user message, rendered from the environment's reset observation."""
    return USER_TEMPLATE.format(
        title=obs.get("title", ""),
        statement=str(obs.get("statement", "")),
        files="\n".join(f"- {f}" for f in obs.get("files") or []),
        editable=", ".join(obs.get("editable") or []),
        visibleTestCmd=obs.get("visibleTestCmd", ""),
        actionBudget=obs.get("actionBudget", ""),
        terminal=terminal_tool,
        timeBudgetSec=round(float(obs.get("timeBudgetSec") or 0)),
    )

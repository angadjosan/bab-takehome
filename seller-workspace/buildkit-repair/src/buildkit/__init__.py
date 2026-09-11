"""buildkit: small helpers for a build tool or package manager (Python 3.12 standard library only).

Import the modules directly, e.g. ``from buildkit.semver import satisfies``. The package does not
import its submodules eagerly, so a problem in one module never breaks the others.
"""

__version__ = "1.0.0"
__all__ = ["config", "cron", "globmatch", "graph", "jsonpointer", "semver"]

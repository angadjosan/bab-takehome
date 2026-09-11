"""EnvMarket reference harness for coding environments, built on Prime Intellect's `verifiers`.

`load_environment(...)` returns a `verifiers` environment (a `vf.MultiTurnEnv` with a hidden-test
`vf.Rubric`) that wraps a seller bundle's grader CLI. Any verifiers-based pipeline can load it:
`vf-eval envmarket_coding -a '{"bundle_dir": ...}'`, `vf.load_environment("envmarket_coding", ...)`,
or prime-rl's orchestrator. `python -m envmarket_coding.run` is the marketplace's pass@1 runner.
"""

__version__ = "0.1.0"


def load_environment(*args, **kwargs):
    """See `envmarket_coding.environment.load_environment` (imported lazily: verifiers is heavy)."""
    from .environment import load_environment as _load_environment

    return _load_environment(*args, **kwargs)


__all__ = ["load_environment", "__version__"]

"""A token-bucket rate limiter with an injectable clock."""

from __future__ import annotations

import math
import time
from typing import Callable

_EPS = 1e-9


class TokenBucket:
    """Token bucket that starts full and refills continuously.

    Tokens accrue at ``rate`` tokens per second of elapsed clock time,
    including fractions of a token, up to ``capacity``. ``clock`` returns
    monotonic seconds as a float (default :func:`time.monotonic`); tests
    inject a fake clock. If the clock ever goes backwards the bucket neither
    gains nor loses tokens.
    """

    def __init__(self, rate: float, capacity: float, clock: Callable[[], float] = time.monotonic) -> None:
        if rate <= 0:
            raise ValueError("rate must be positive")
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.rate = float(rate)
        self.capacity = float(capacity)
        self._clock = clock
        self._tokens = self.capacity
        self._last = clock()

    def _refill(self) -> None:
        now = self._clock()
        elapsed = now - self._last
        if elapsed > 0:
            # Credit whole tokens only so a caller can never be admitted on a
            # partially refilled token.
            earned = math.floor(elapsed * self.rate)
            self._tokens = min(self.capacity, self._tokens + earned)
            self._last = now

    def available(self) -> float:
        """Tokens currently available (may be fractional)."""
        self._refill()
        return self._tokens

    def try_acquire(self, n: float = 1) -> bool:
        """Take ``n`` tokens if available; return whether it succeeded."""
        if n <= 0:
            raise ValueError("n must be positive")
        if n > self.capacity:
            raise ValueError("request exceeds bucket capacity")
        self._refill()
        if self._tokens + _EPS >= n:
            self._tokens = max(0.0, self._tokens - n)
            return True
        return False

    def time_until(self, n: float = 1) -> float:
        """Seconds until ``n`` tokens will be available (0.0 if already)."""
        if n > self.capacity:
            raise ValueError("request exceeds bucket capacity")
        self._refill()
        deficit = n - self._tokens
        return 0.0 if deficit <= _EPS else deficit / self.rate

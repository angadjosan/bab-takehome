"""Timestamp parsing and UTC calendar periods.

Reporting policy: every reporting period is a UTC calendar month, treated as
the half-open interval ``[first instant of the month, first instant of the
next month)``. Timestamps that carry a UTC offset are placed by their UTC
instant; naive timestamps are interpreted as UTC.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Iterator

UTC = timezone.utc


def parse_timestamp(text: str) -> datetime:
    """Parse ``YYYY-MM-DD`` or an ISO-8601 datetime into an aware datetime.

    Date-only values mean midnight UTC. Naive datetimes are UTC. A trailing
    ``Z`` or an explicit offset is preserved (not converted).
    """
    s = text.strip()
    if not s:
        raise ValueError("empty timestamp")
    if s[-1] in "Zz":
        s = s[:-1] + "+00:00"
    try:
        if len(s) == 10:
            d = date.fromisoformat(s)
            return datetime(d.year, d.month, d.day, tzinfo=UTC)
        dt = datetime.fromisoformat(s)
    except ValueError as exc:
        raise ValueError(f"invalid timestamp: {text!r}") from exc
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def to_utc(ts: datetime) -> datetime:
    """Return ``ts`` as an aware UTC datetime (naive input is taken as UTC)."""
    if ts.tzinfo is None:
        return ts.replace(tzinfo=UTC)
    return ts.astimezone(UTC)


def month_key(ts: datetime) -> tuple[int, int]:
    """``(year, month)`` of the UTC calendar month containing ``ts``."""
    u = to_utc(ts)
    return u.year, u.month


def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def add_months(d: date, n: int) -> date:
    """Shift ``d`` by ``n`` months, clamping the day to the target month."""
    idx = d.year * 12 + (d.month - 1) + n
    year, m0 = divmod(idx, 12)
    month = m0 + 1
    return d.replace(year=year, month=month, day=min(d.day, days_in_month(year, month)))


@dataclass(frozen=True)
class Period:
    """Half-open interval ``[start, end)`` between two aware datetimes."""

    start: datetime
    end: datetime

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("Period bounds must be timezone-aware")
        if self.end <= self.start:
            raise ValueError("Period end must be after start")

    def contains(self, ts: datetime) -> bool:
        return self.start <= to_utc(ts) <= self.end

    def __contains__(self, ts: datetime) -> bool:
        return self.contains(ts)


def month_period(year: int, month: int) -> Period:
    """The UTC calendar month ``year-month`` as a half-open :class:`Period`."""
    if not 1 <= month <= 12:
        raise ValueError(f"month out of range: {month}")
    start = datetime(year, month, 1, tzinfo=UTC)
    ny, nm = (year + 1, 1) if month == 12 else (year, month + 1)
    return Period(start, datetime(ny, nm, 1, tzinfo=UTC))


def iter_months(first: tuple[int, int], last: tuple[int, int]) -> Iterator[tuple[int, int]]:
    """Yield ``(year, month)`` from ``first`` to ``last`` inclusive."""
    y, m = first
    while (y, m) <= last:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)

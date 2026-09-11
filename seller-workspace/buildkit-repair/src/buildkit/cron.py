"""Next-run times for 5-field cron expressions.

    minute  hour  day-of-month  month  day-of-week
    0-59    0-23  1-31          1-12   0-7 (0 and 7 are both Sunday)

A field is "*" or a comma-separated list of items. An item is a number, a range "a-b", or either of
those or "*" followed by a step "/n". Steps count from the start of what they apply to: "*/n" from
the field's minimum ("*/2" in day-of-month is 1,3,5,...), "a-b/n" from a, and "a/n" means
"a-max/n". Names (JAN, MON) are not supported.

Day rule (classic cron): a day-of-month or day-of-week field is "restricted" unless its text is
exactly "*". If both are restricted, a day matches when EITHER field matches; if only one is
restricted, only that one counts; if neither is, every day matches.

next_run(expr, now) returns the earliest datetime strictly after `now`, at minute resolution
(seconds and microseconds 0), at which the expression fires. `now` is always passed in; this module
never reads the clock. The calculation uses the wall-clock fields of `now` and keeps its tzinfo
(no DST adjustment). CronError is raised for invalid expressions and for schedules that do not
fire within 8 calendar years after now.year (e.g. "0 0 30 2 *").
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

_FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day of month", 1, 31), ("month", 1, 12), ("day of week", 0, 7))
SEARCH_YEARS = 8


class CronError(ValueError):
    pass


def _num(text: str, name: str) -> int:
    if not text.isdigit():
        raise CronError(f"bad {name} value {text!r}")
    return int(text)


def _field(text: str, name: str, lo: int, hi: int) -> frozenset[int]:
    values: set[int] = set()
    for item in text.split(","):
        base, slash, step_text = item.partition("/")
        step = _num(step_text, name) if slash else 1
        if step == 0:
            raise CronError(f"step must be positive in {name} {item!r}")
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a, _, b = base.partition("-")
            start, end = _num(a, name), _num(b, name)
        else:
            start = _num(base, name)
            end = hi if slash else start
        if not lo <= start <= end <= hi:
            raise CronError(f"{name} {item!r} is outside {lo}-{hi} or reversed")
        values.update(range(start, end + 1, step))
    return frozenset(values)


@dataclass(frozen=True)
class Schedule:
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]
    dom_restricted: bool
    dow_restricted: bool

    def day_matches(self, when: datetime) -> bool:
        dom_ok = when.day in self.days
        dow_ok = (when.weekday() + 1) % 7 in self.weekdays
        if self.dom_restricted and self.dow_restricted:
            return dom_ok or dow_ok
        if self.dom_restricted:
            return dom_ok
        return dow_ok if self.dow_restricted else True


def parse(expr: str) -> Schedule:
    parts = expr.split()
    if len(parts) != 5:
        raise CronError(f"expected 5 fields, got {len(parts)}: {expr!r}")
    sets = [_field(p, name, lo, hi) for p, (name, lo, hi) in zip(parts, _FIELDS)]
    weekdays = frozenset(d % 7 for d in sets[4])
    return Schedule(sets[0], sets[1], sets[2], sets[3], weekdays, parts[2] != "*", parts[4] != "*")


def _next_month(t: datetime) -> datetime:
    year, month = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
    return t.replace(year=year, month=month, day=1, hour=0, minute=0)


def next_run(expr: str | Schedule, now: datetime) -> datetime:
    sched = parse(expr) if isinstance(expr, str) else expr
    t = now.replace(second=0, microsecond=0) + timedelta(minutes=1)
    while t.year <= now.year + SEARCH_YEARS:
        if t.month not in sched.months:
            t = _next_month(t)
        elif not sched.day_matches(t):
            t = t.replace(hour=0, minute=0) + timedelta(days=1)
        elif t.hour not in sched.hours:
            t = t.replace(minute=0) + timedelta(hours=1)
        elif t.minute not in sched.minutes:
            t += timedelta(minutes=1)
        else:
            return t
    raise CronError(f"{expr!r} does not fire within {SEARCH_YEARS} years after {now.year}")

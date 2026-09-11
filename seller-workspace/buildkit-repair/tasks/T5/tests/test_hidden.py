from datetime import datetime, timedelta, timezone

import pytest

from buildkit.cron import CronError, next_run

# 2026-09-11 is a Friday; 2026-09-14 is a Monday.


def test_weekly_job_asked_after_its_time_of_day():
    assert next_run("0 9 * * 2", datetime(2026, 9, 14, 10, 30)) == datetime(2026, 9, 15, 9, 0)


def test_weekly_job_asked_before_its_time_of_day():
    assert next_run("0 9 * * 2", datetime(2026, 9, 14, 8, 30)) == datetime(2026, 9, 15, 9, 0)


def test_monthly_job_asked_late_on_the_last_day():
    assert next_run("0 3 1 * *", datetime(2026, 9, 30, 4, 0)) == datetime(2026, 10, 1, 3, 0)
    assert next_run("45 23 1 * *", datetime(2026, 9, 30, 23, 50)) == datetime(2026, 10, 1, 23, 45)


def test_sunday_is_both_0_and_7():
    assert next_run("15 10 * * 7", datetime(2026, 9, 14, 12, 0)) == datetime(2026, 9, 20, 10, 15)
    assert next_run("15 10 * * 0", datetime(2026, 9, 14, 12, 0)) == datetime(2026, 9, 20, 10, 15)


def test_weekdays_across_weekend():
    assert next_run("30 8 * * 1-5", datetime(2026, 9, 11, 18, 0)) == datetime(2026, 9, 14, 8, 30)
    assert next_run("30 8 * * 1-5", datetime(2026, 9, 12, 9, 0)) == datetime(2026, 9, 14, 8, 30)


def test_day_of_month_or_day_of_week():
    # both restricted: the 13th OR any Friday
    assert next_run("0 0 13 * 5", datetime(2026, 9, 11, 12, 0)) == datetime(2026, 9, 13, 0, 0)
    # the 1st OR any Monday, asked on a Saturday after 09:00
    assert next_run("0 9 1 * 1", datetime(2026, 9, 12, 10, 0)) == datetime(2026, 9, 14, 9, 0)
    # only day-of-month restricted
    assert next_run("0 0 13 * *", datetime(2026, 9, 13, 0, 0)) == datetime(2026, 10, 13, 0, 0)


def test_strictly_after_now_and_seconds_dropped():
    assert next_run("*/15 * * * *", datetime(2026, 9, 11, 10, 15, 0)) == datetime(2026, 9, 11, 10, 30)
    assert next_run("*/15 * * * *", datetime(2026, 9, 11, 10, 14, 59, 999)) == datetime(2026, 9, 11, 10, 15)
    assert next_run("* * * * *", datetime(2026, 9, 11, 10, 14, 30)) == datetime(2026, 9, 11, 10, 15)


def test_steps_ranges_and_lists():
    assert next_run("0 */6 * * *", datetime(2026, 9, 11, 13, 0)) == datetime(2026, 9, 11, 18, 0)
    assert next_run("5-50/15 * * * *", datetime(2026, 9, 11, 10, 6)) == datetime(2026, 9, 11, 10, 20)
    assert next_run("0 0 */10 * *", datetime(2026, 9, 11, 12, 0)) == datetime(2026, 9, 21, 0, 0)
    assert next_run("0 12 1,15 * *", datetime(2026, 9, 15, 13, 0)) == datetime(2026, 10, 1, 12, 0)
    assert next_run("10 4 20/5 * *", datetime(2026, 9, 21, 5, 0)) == datetime(2026, 9, 25, 4, 10)


def test_leap_day_and_year_rollover():
    assert next_run("30 6 29 2 *", datetime(2028, 2, 28, 7, 0)) == datetime(2028, 2, 29, 6, 30)
    assert next_run("0 0 29 2 *", datetime(2026, 9, 11)) == datetime(2028, 2, 29, 0, 0)
    assert next_run("0 0 1 1 *", datetime(2026, 12, 31, 23, 59)) == datetime(2027, 1, 1, 0, 0)
    assert next_run("0 7 31 * *", datetime(2026, 9, 30, 8, 0)) == datetime(2026, 10, 31, 7, 0)


def test_timezone_is_kept():
    tz = timezone(timedelta(hours=-5))
    got = next_run("0 9 * * 2", datetime(2026, 9, 14, 10, 30, tzinfo=tz))
    assert got == datetime(2026, 9, 15, 9, 0, tzinfo=tz)
    assert got.tzinfo is tz


def test_invalid_and_never_firing_expressions():
    now = datetime(2026, 9, 11)
    for expr in ["0 0 30 2 *", "60 * * * *", "* * * *", "5-1 * * * *", "*/0 * * * *", "* * 0 * *", "* * * 13 *", "a * * * *"]:
        with pytest.raises(CronError):
            next_run(expr, now)

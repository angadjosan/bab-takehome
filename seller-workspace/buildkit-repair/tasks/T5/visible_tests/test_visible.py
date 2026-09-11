from datetime import datetime

from buildkit.cron import next_run


def test_tuesday_job_asked_on_monday_afternoon():
    # 2026-09-14 is a Monday
    assert next_run("0 9 * * 2", datetime(2026, 9, 14, 10, 30)) == datetime(2026, 9, 15, 9, 0)


def test_daily_job():
    assert next_run("0 9 * * *", datetime(2026, 9, 14, 10, 30)) == datetime(2026, 9, 15, 9, 0)

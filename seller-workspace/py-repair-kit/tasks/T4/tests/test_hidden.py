import pytest

from ledgerlite.ratelimit import TokenBucket


class FakeClock:
    def __init__(self, t: float = 0.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


def drained(rate, capacity):
    clk = FakeClock()
    bucket = TokenBucket(rate, capacity, clock=clk)
    while bucket.try_acquire():
        pass
    return clk, bucket


def test_fractional_progress_is_kept_between_calls():
    clk, b = drained(2, 2)
    clk.advance(0.25)
    assert not b.try_acquire()
    clk.advance(0.25)
    assert b.try_acquire()


def test_polling_every_300ms_admits_about_two_per_second():
    clk, b = drained(2, 2)
    admitted = 0
    for _ in range(20):  # 6 seconds
        clk.advance(0.3)
        admitted += b.try_acquire()
    assert 11 <= admitted <= 12


def test_available_reports_fractional_tokens():
    clk, b = drained(4, 10)
    clk.advance(0.125)
    assert b.available() == pytest.approx(0.5)


def test_refill_is_capped_at_capacity():
    clk, b = drained(5, 3)
    clk.advance(100)
    assert b.available() == pytest.approx(3.0)
    assert [b.try_acquire() for _ in range(4)] == [True, True, True, False]


def test_time_until_accounts_for_partial_refill():
    clk, b = drained(2, 2)
    assert b.time_until(1) == pytest.approx(0.5)
    clk.advance(0.2)
    assert b.time_until(1) == pytest.approx(0.3)


def test_fine_grained_clock_respects_rate():
    clk, b = drained(10, 1)
    admitted = 0
    for _ in range(1000):  # 10 seconds in 10 ms steps
        clk.advance(0.01)
        admitted += b.try_acquire()
    assert 99 <= admitted <= 101


def test_backwards_clock_is_ignored():
    clk, b = drained(1, 1)
    clk.t = -5.0
    assert b.available() == pytest.approx(0.0)
    clk.t = 1.0
    assert b.available() == pytest.approx(1.0)


def test_partial_refill_then_multi_token_request():
    clk, b = drained(1, 5)
    clk.advance(2.5)
    assert not b.try_acquire(3)
    assert b.try_acquire(2)
    assert b.available() == pytest.approx(0.5)


def test_starts_full_and_validates_arguments():
    b = TokenBucket(1, 3, clock=FakeClock())
    assert b.available() == pytest.approx(3.0)
    with pytest.raises(ValueError):
        TokenBucket(0, 1)
    with pytest.raises(ValueError):
        TokenBucket(1, 0)
    with pytest.raises(ValueError):
        b.try_acquire(4)
    with pytest.raises(ValueError):
        b.try_acquire(0)

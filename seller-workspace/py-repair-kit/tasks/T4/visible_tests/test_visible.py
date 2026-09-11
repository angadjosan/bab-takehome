from ledgerlite.ratelimit import TokenBucket


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_frequent_polling_is_eventually_admitted():
    clk = FakeClock()
    bucket = TokenBucket(rate=2, capacity=1, clock=clk)
    assert bucket.try_acquire()
    admitted = 0
    for _ in range(10):  # poll every 300 ms for 3 seconds
        clk.t += 0.3
        admitted += bucket.try_acquire()
    assert admitted >= 2, f"only {admitted} requests admitted in 3 s at rate=2/s"

import pytest

from ledgerlite.lru import LRUCache


def test_get_marks_key_most_recently_used():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1
    c.put("c", 3)
    assert "a" in c and "c" in c
    assert "b" not in c


def test_keys_order_reflects_reads():
    c = LRUCache(3)
    for k in "abc":
        c.put(k, k.upper())
    c.get("a")
    assert c.keys() == ["b", "c", "a"]
    c.get("b")
    assert c.keys() == ["c", "a", "b"]


def test_hot_key_survives_churn():
    c = LRUCache(3)
    c.put("hot", 0)
    for i in range(20):
        assert c.get("hot") == 0
        c.put(i, i)
    assert "hot" in c
    assert c.keys()[-1] == 19


def test_miss_does_not_reorder():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("zzz", "dflt") == "dflt"
    assert c.keys() == ["a", "b"]


def test_put_existing_key_refreshes_and_updates():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.put("a", 10)
    c.put("c", 3)
    assert c.keys() == ["a", "c"]
    assert c.peek("a") == 10


def test_peek_and_contains_do_not_refresh():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.peek("a") == 1
    assert "a" in c
    c.put("c", 3)
    assert "a" not in c
    assert c.keys() == ["b", "c"]


def test_statistics_follow_recency():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")
    c.get("x")
    c.put("c", 3)
    assert c.get("b") is None
    assert (c.hits, c.misses, c.evictions) == (1, 2, 1)


def test_capacity_one():
    c = LRUCache(1)
    c.put("a", 1)
    assert c.get("a") == 1
    c.put("b", 2)
    assert c.keys() == ["b"]
    assert c.get("a") is None


@pytest.mark.parametrize("bad", [0, -1, True, 1.5])
def test_invalid_capacity(bad):
    with pytest.raises(ValueError):
        LRUCache(bad)

from ledgerlite.lru import LRUCache


def test_recently_read_entry_is_kept():
    c = LRUCache(2)
    c.put("x", 10)
    c.put("y", 20)
    assert c.get("x") == 10
    c.put("z", 30)
    assert c.peek("x") == 10, "x was just read, so y should have been evicted instead"

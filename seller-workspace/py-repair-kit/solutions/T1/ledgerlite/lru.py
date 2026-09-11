"""A fixed-capacity least-recently-used (LRU) cache."""

from __future__ import annotations

from collections import OrderedDict
from typing import Any, Hashable

_MISSING = object()


class LRUCache:
    """Mapping with a fixed capacity that evicts the least recently used entry.

    Both :meth:`get` (on a hit) and :meth:`put` count as a *use* of a key and
    make it the most recently used. ``key in cache``, :meth:`peek`,
    :meth:`keys` and ``len()`` do not change recency. :meth:`keys` lists keys
    from least to most recently used.
    """

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise ValueError("capacity must be a positive integer")
        self.capacity = capacity
        self._data: OrderedDict[Hashable, Any] = OrderedDict()
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def get(self, key: Hashable, default: Any = None) -> Any:
        try:
            value = self._data[key]
        except KeyError:
            self.misses += 1
            return default
        self._data.move_to_end(key)
        self.hits += 1
        return value

    def peek(self, key: Hashable, default: Any = None) -> Any:
        return self._data.get(key, default)

    def put(self, key: Hashable, value: Any) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = value
        while len(self._data) > self.capacity:
            self._data.popitem(last=False)
            self.evictions += 1

    def pop(self, key: Hashable, default: Any = _MISSING) -> Any:
        if default is _MISSING:
            return self._data.pop(key)
        return self._data.pop(key, default)

    def clear(self) -> None:
        self._data.clear()

    def keys(self) -> list[Hashable]:
        return list(self._data.keys())

    def __contains__(self, key: object) -> bool:
        return key in self._data

    def __len__(self) -> int:
        return len(self._data)

    def __repr__(self) -> str:
        return f"LRUCache(capacity={self.capacity}, size={len(self)})"

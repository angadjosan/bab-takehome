"""An in-memory ledger with memoised balance queries."""

from __future__ import annotations

import os
from datetime import datetime
from decimal import Decimal
from typing import Iterable, Iterator, Optional, Union

from .csvimport import Transaction, read_transactions
from .dates import to_utc
from .lru import LRUCache
from .tokenizer import hashtags


class Ledger:
    """Holds transactions; answers balance and tag queries.

    ``balance(account, as_of)`` sums amounts strictly before ``as_of``
    (compared as UTC instants); without ``as_of`` it sums everything.
    Results are memoised in an :class:`LRUCache` that is cleared whenever a
    transaction is added.
    """

    def __init__(self, cache_size: int = 128) -> None:
        self._txs: list[Transaction] = []
        self._cache = LRUCache(cache_size)

    def add(self, tx: Transaction) -> None:
        self._txs.append(tx)
        self._cache.clear()

    def extend(self, txs: Iterable[Transaction]) -> None:
        for tx in txs:
            self.add(tx)

    def import_csv(self, path: Union[str, os.PathLike]) -> int:
        txs = read_transactions(path)
        self.extend(txs)
        return len(txs)

    def __len__(self) -> int:
        return len(self._txs)

    def __iter__(self) -> Iterator[Transaction]:
        return iter(sorted(self._txs, key=lambda t: to_utc(t.timestamp)))

    def accounts(self) -> list[str]:
        return sorted({t.account for t in self._txs})

    def balance(self, account: str, as_of: Optional[datetime] = None) -> Decimal:
        cutoff = to_utc(as_of) if as_of is not None else None
        key = (account, cutoff)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        total = Decimal("0.00")
        for t in self._txs:
            if t.account == account and (cutoff is None or to_utc(t.timestamp) < cutoff):
                total += t.amount
        self._cache.put(key, total)
        return total

    def total(self) -> Decimal:
        return sum((t.amount for t in self._txs), Decimal("0.00"))

    def tagged(self, tag: str) -> list[Transaction]:
        """Transactions whose memo contains ``#tag`` (case-insensitive)."""
        want = tag.lstrip("#").lower()
        return [t for t in self if want in hashtags(t.memo)]

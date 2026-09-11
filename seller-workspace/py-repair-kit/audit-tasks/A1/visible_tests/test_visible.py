from decimal import Decimal

from ledgerlite.tokenizer import amounts_in


def test_thousands_separator_amount_is_one_token():
    assert amounts_in("Transfer 2,000 to savings") == [Decimal("2000")]

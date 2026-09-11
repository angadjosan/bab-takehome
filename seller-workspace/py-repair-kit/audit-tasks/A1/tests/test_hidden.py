from decimal import Decimal as D

from ledgerlite.tokenizer import amounts_in, hashtags, tokenize


def test_grouped_amount_with_symbol():
    assert amounts_in("Paid $1,234.50 to ACME #rent") == [D("1234.50")]


def test_millions():
    assert amounts_in("Wire 1,000,000 received") == [D("1000000")]


def test_negative_grouped_amount():
    assert amounts_in("refund -$2,500.00 #refund") == [D("-2500.00")]


def test_token_text_is_preserved():
    assert [t.text for t in tokenize("Rent $1,200 #home")] == ["Rent", "$1,200", "#home"]


def test_plain_amounts_still_work():
    assert amounts_in("tip 5 and 12.75") == [D("5"), D("12.75")]


def test_malformed_grouping_is_not_merged():
    assert amounts_in("codes 12,34") == [D("12"), D("34")]


def test_hashtags_mentions_and_words():
    toks = tokenize("Don't pay @ACME twice #Dup")
    assert [(t.kind, t.value) for t in toks] == [
        ("word", "don't"),
        ("word", "pay"),
        ("mention", "acme"),
        ("word", "twice"),
        ("hashtag", "dup"),
    ]
    assert hashtags("#a #B_2 # c") == ["a", "b_2"]

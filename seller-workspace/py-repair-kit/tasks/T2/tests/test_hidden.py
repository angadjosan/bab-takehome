import codecs
from decimal import Decimal

from ledgerlite.csvimport import parse_transactions, read_transactions
from ledgerlite.ledger import Ledger

BOM = "\ufeff"


def test_bom_before_plain_header():
    txs = parse_transactions(BOM + "Date,Account,Amount\n2024-01-02,checking,5.00\n")
    assert len(txs) == 1
    assert txs[0].account == "checking"
    assert txs[0].amount == Decimal("5.00")


def test_read_transactions_excel_utf8_file(tmp_path):
    p = tmp_path / "export.csv"
    p.write_bytes(
        codecs.BOM_UTF8
        + b"Date,Account,Amount,Memo\r\n2024-02-01,savings,100.00,opening\r\n2024-02-03,savings,-20.50,atm\r\n"
    )
    txs = read_transactions(p)
    assert [t.amount for t in txs] == [Decimal("100.00"), Decimal("-20.50")]
    assert txs[1].memo == "atm"


def test_bom_with_alias_headers():
    txs = parse_transactions(BOM + "Posted,Acct,Value,Description\n2024-03-04T10:00:00Z,card,-12.00,coffee\n")
    assert txs[0].memo == "coffee"
    assert txs[0].amount == Decimal("-12.00")


def test_bom_before_quoted_header():
    text = BOM + '"Date","Account","Amount"\n2024-01-02,"checking","1,234.50"\n'
    assert parse_transactions(text)[0].amount == Decimal("1234.50")


def test_ledger_import_csv_with_bom(tmp_path):
    p = tmp_path / "a.csv"
    p.write_bytes(codecs.BOM_UTF8 + b"Date,Account,Amount\n2024-05-01,chk,10\n2024-05-02,chk,2.5\n")
    ledger = Ledger()
    assert ledger.import_csv(p) == 2
    assert ledger.balance("chk") == Decimal("12.5")

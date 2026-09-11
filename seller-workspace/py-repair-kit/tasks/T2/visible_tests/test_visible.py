from ledgerlite.csvimport import parse_transactions


def test_excel_export_with_bom_imports():
    text = "\ufeffDate,Account,Amount\n2024-07-01,checking,42.00\n"
    txs = parse_transactions(text)
    assert len(txs) == 1
    assert txs[0].account == "checking"

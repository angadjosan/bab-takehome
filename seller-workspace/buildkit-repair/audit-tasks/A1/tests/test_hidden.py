import codecs

import pytest

from buildkit.dotenv import DotenvError, load_dotenv, parse_dotenv


def test_hash_at_start_of_unquoted_value_is_kept():
    assert parse_dotenv("CI_COLOR=#36a64f\n") == {"CI_COLOR": "#36a64f"}


def test_hash_inside_unquoted_value_is_kept():
    env = parse_dotenv("WEBHOOK_URL=https://hooks.example.com/services/T0#alerts\nTAG=v1#2\n")
    assert env == {"WEBHOOK_URL": "https://hooks.example.com/services/T0#alerts", "TAG": "v1#2"}


def test_whitespace_then_hash_starts_a_comment():
    env = parse_dotenv("A=one # the first\nB=two\t#tabbed\nC=#fff # colour\nD=x#y #z\n")
    assert env == {"A": "one", "B": "two", "C": "#fff", "D": "x#y"}


def test_quoted_values_keep_hash():
    env = parse_dotenv("S='a # b'\nD=\"c # d\"  # trailing comment\n")
    assert env == {"S": "a # b", "D": "c # d"}


def test_double_quote_escapes_and_single_quote_literals():
    env = parse_dotenv('D="line1\\nline2\\t\\"q\\" \\\\ \\x"\nS=\'raw\\n\'\n')
    assert env == {"D": 'line1\nline2\t"q" \\ \\x', "S": "raw\\n"}


def test_export_whitespace_comments_and_later_wins():
    text = "# header\n\n  export  API_URL = https://api.example.com  \nNAME=first\nNAME=second\nEMPTY=\n"
    assert parse_dotenv(text) == {"API_URL": "https://api.example.com", "NAME": "second", "EMPTY": ""}


def test_malformed_lines_report_line_numbers():
    for text, line in [("A=1\nnot a pair\n", 2), ("A='open\n", 1), ('A=1\nB=2\nC="open\n', 3), ("A='x' y\n", 1), ("1A=2\n", 1)]:
        with pytest.raises(DotenvError, match=rf"^line {line}:"):
            parse_dotenv(text)


def test_load_dotenv_reads_utf8_with_bom(tmp_path):
    p = tmp_path / ".env"
    p.write_bytes(codecs.BOM_UTF8 + b"COLOR=#abcdef\nNAME='caf\xc3\xa9 # 1'\n")
    assert load_dotenv(p) == {"COLOR": "#abcdef", "NAME": "caf\u00e9 # 1"}

from buildkit.dotenv import parse_dotenv


def test_hex_colour_value():
    assert parse_dotenv("CI_COLOR=#36a64f\n") == {"CI_COLOR": "#36a64f"}


def test_inline_comment():
    assert parse_dotenv("RETRIES=3 # per job\n") == {"RETRIES": "3"}

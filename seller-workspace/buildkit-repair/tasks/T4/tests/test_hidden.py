import pytest

from buildkit.jsonpointer import JsonPointerError, escape, get, parse, set, to_pointer


def test_tilde_zero_one_decodes_to_tilde_one():
    assert parse("/a~01b") == ["a~1b"]
    assert parse("/~01") == ["~1"]
    assert get({"a~1b": 1, "a/b": 2}, "/a~01b") == 1


def test_escape_round_trip():
    keys = ["left-pad@~1.1", "a/b", "~", "~1", "~0", "/~", "~/", "plain", ""]
    assert parse(to_pointer(keys)) == keys


def test_get_with_escaped_lockfile_keys():
    doc = {"deps": {"left-pad@~1.1": {"version": "1.1.3"}, "@scope/pkg": {"version": "2.0.0"}}}
    assert get(doc, "/deps/" + escape("left-pad@~1.1") + "/version") == "1.1.3"
    assert get(doc, "/deps/@scope~1pkg/version") == "2.0.0"


def test_rfc6901_examples():
    doc = {"foo": ["bar", "baz"], "": 0, "a/b": 1, "c%d": 2, "e^f": 3, "g|h": 4, "i\\j": 5, 'k"l': 6, " ": 7, "m~n": 8}
    assert get(doc, "") is doc
    assert get(doc, "/foo") == ["bar", "baz"]
    assert get(doc, "/foo/0") == "bar"
    assert get(doc, "/") == 0
    assert get(doc, "/a~1b") == 1
    assert get(doc, "/c%d") == 2
    assert get(doc, "/ ") == 7
    assert get(doc, "/m~0n") == 8


def test_default_only_used_for_missing_values():
    assert get({"a": {"~1": 5}}, "/a/~01", default="d") == 5
    assert get({"a": {"/": 6}}, "/a/~1", default="d") == 6
    assert get({"a": {}}, "/a/~01", default="d") == "d"


def test_set_with_escaped_key_and_array_positions():
    doc = {"deps": {}, "list": [1]}
    assert set(doc, "/deps/" + escape("x@~1.0"), "1.0.4") is doc
    assert doc["deps"] == {"x@~1.0": "1.0.4"}
    set(doc, "/list/-", 2)
    set(doc, "/list/2", 3)
    set(doc, "/list/0", 0)
    assert doc["list"] == [0, 2, 3]
    set(doc, "/deps/~0~1", True)
    assert doc["deps"]["~/"] is True


def test_get_rejects_dash_and_bad_indexes():
    doc = {"a": [1]}
    for pointer in ["/a/-", "/a/01", "/a/1", "/a/-1", "/a/x", "/b"]:
        with pytest.raises(JsonPointerError):
            get(doc, pointer)
    assert get(doc, "/a/5", default=None) is None


def test_malformed_pointers_always_raise():
    for pointer in ["/a~2", "/a~", "a", "/~a"]:
        with pytest.raises(JsonPointerError):
            parse(pointer)
        with pytest.raises(JsonPointerError):
            get({"a": 1}, pointer, default=None)


def test_set_root_and_errors():
    assert set({"a": 1}, "", [1]) == [1]
    with pytest.raises(JsonPointerError):
        set({"a": [1]}, "/a/3", 0)
    with pytest.raises(JsonPointerError):
        set({}, "/missing/x", 1)


def test_escape_encodes_tilde_before_slash():
    assert escape("~/") == "~0~1"
    assert escape("a~1") == "a~01"
    assert to_pointer(["a~1", "b/c"]) == "/a~01/b~1c"

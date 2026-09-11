from buildkit.jsonpointer import escape, get


def test_lookup_of_key_with_tilde_range():
    lock = {"deps": {"left-pad@~1.1": {"version": "1.1.3"}}}
    assert get(lock, "/deps/" + escape("left-pad@~1.1") + "/version") == "1.1.3"

from buildkit.config import merge_layers


def test_staging_override_does_not_leak_into_prod():
    defaults = {"db": {"host": "localhost", "port": 5432}}
    merge_layers(defaults, {"db": {"host": "staging-db"}})
    prod = merge_layers(defaults, {"db": {"port": 6432}})
    assert prod == {"db": {"host": "localhost", "port": 6432}}


def test_later_layer_wins():
    assert merge_layers({"a": 1, "b": [1, 2]}, {"b": [3]}) == {"a": 1, "b": [3]}

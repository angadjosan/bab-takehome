import copy
from types import MappingProxyType

import pytest

from buildkit.config import ConfigError, interpolate, load, merge_layers


def test_repeated_merges_from_the_same_defaults_are_independent():
    defaults = {"db": {"host": "localhost", "port": 5432}}
    staging = merge_layers(defaults, {"db": {"host": "staging-db"}})
    prod = merge_layers(defaults, {"db": {"port": 6432}})
    assert staging == {"db": {"host": "staging-db", "port": 5432}}
    assert prod == {"db": {"host": "localhost", "port": 6432}}


def test_layers_are_not_modified():
    defaults = {"db": {"host": "localhost", "port": 5432, "opts": {"ssl": False}}, "tags": ["a"]}
    override = {"db": {"host": "staging", "opts": {"ssl": True}}, "tags": ["b"]}
    snapshot = copy.deepcopy((defaults, override))
    merge_layers(defaults, override, {"db": {"opts": {"timeout": 5}}})
    assert (defaults, override) == snapshot


def test_result_shares_nothing_with_layers():
    base = {"db": {"hosts": ["a"]}, "flags": {"x": 1}}
    over = {"extra": {"list": [1, 2]}, "flags": {"y": 2}}
    result = merge_layers(base, over)
    result["db"]["hosts"].append("b")
    result["extra"]["list"].append(3)
    result["flags"]["z"] = 3
    assert base == {"db": {"hosts": ["a"]}, "flags": {"x": 1}}
    assert over == {"extra": {"list": [1, 2]}, "flags": {"y": 2}}


def test_single_layer_is_copied():
    layer = {"a": {"b": [1]}}
    result = merge_layers(layer)
    result["a"]["b"].append(2)
    result["a"]["c"] = 1
    assert layer == {"a": {"b": [1]}}


def test_changing_a_layer_later_does_not_change_the_result():
    layer = {"a": {"b": [1]}, "c": {"d": 1}}
    result = merge_layers(layer, {"c": {"e": 2}})
    layer["a"]["b"].append(99)
    layer["c"]["d"] = 99
    assert result == {"a": {"b": [1]}, "c": {"d": 1, "e": 2}}


def test_precedence_and_replacement_rules():
    result = merge_layers(
        {"a": [1, 2], "b": {"x": 1}, "c": 1, "d": {"k": 1}, "keep": True},
        {"a": [3], "b": 5, "c": {"y": 2}, "d": None},
    )
    assert result == {"a": [3], "b": 5, "c": {"y": 2}, "d": None, "keep": True}
    three = merge_layers({"s": {"a": 1, "b": 1}}, {"s": {"b": 2, "c": 2}}, {"s": {"c": 3}})
    assert three == {"s": {"a": 1, "b": 2, "c": 3}}


def test_mapping_types_become_plain_dicts_and_lists():
    result = merge_layers(MappingProxyType({"a": MappingProxyType({"b": 1})}), {"a": {"c": 2}, "t": (1, 2)})
    assert result == {"a": {"b": 1, "c": 2}, "t": [1, 2]}
    assert type(result["a"]) is dict


def test_non_mapping_layer_rejected():
    with pytest.raises(ConfigError):
        merge_layers({"a": 1}, ["not", "a", "mapping"])


def test_interpolation():
    env = {"HOST": "db.internal", "EMPTY": "", "PRICE": "$5", "NESTED": "${HOST}"}
    layer = {"url": "postgres://${HOST}/app", "x": "${EMPTY:-fallback}", "y": "$${HOST}", "z": "${PRICE}",
             "w": "${NESTED}", "n": 5, "l": ["${HOST}", {"k": "${MISSING:-d}"}], "cost": "$10"}
    assert load([layer], env) == {
        "url": "postgres://db.internal/app", "x": "fallback", "y": "${HOST}", "z": "$5",
        "w": "${HOST}", "n": 5, "l": ["db.internal", {"k": "d"}], "cost": "$10",
    }


def test_missing_variable_names_the_path():
    with pytest.raises(ConfigError, match=r"DB_PASS.*servers\.1\.password"):
        load([{"servers": [{}, {"password": "${DB_PASS}"}]}], {})
    with pytest.raises(ConfigError, match=r"TOKEN.*api\.auth"):
        interpolate({"api": {"auth": "Bearer ${TOKEN}"}}, {})


def test_load_with_overrides_leaves_layers_alone():
    base = {"db": {"url": "postgres://${HOST}/app", "pool": {"size": 5}}}
    local = {"db": {"pool": {"size": 1}}}
    snapshot = copy.deepcopy((base, local))
    assert load([base, local], {"HOST": "h"}) == {"db": {"url": "postgres://h/app", "pool": {"size": 1}}}
    assert load([base], {"HOST": "h"}) == {"db": {"url": "postgres://h/app", "pool": {"size": 5}}}
    assert (base, local) == snapshot

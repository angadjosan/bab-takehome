# Seeded dispute (demo operator only; do not ship)

`py-repair-kit/listing/description.json` contains exactly one deliberately false claim, so the demo
can exercise a **FalseDescription** dispute.

| Field | Value |
|---|---|
| Claim id | **C10** (category `testCoverage`) |
| Claim text | "Every purchased task's hidden test suite contains at least 8 test cases as collected by pytest." |
| Why it is false | `tasks/T2/tests/test_hidden.py` has **5** test cases (5 plain functions, no parametrization). Every other purchased task has 8 or more: T1 12, T3 13, T4 9, T5 10. |
| Affected task | **T2** (index 1 in manifest `taskIds` = [T1, T2, T3, T4, T5]) |
| On-chain taskMask | `1 << 1` = **`0x2`** (decimal 2) |
| Expected verdict | Uphold (buyer wins): refund = price / 5 for one task, bond returned |

## How the buyer checks it from the delivered bundle

From the bundle root, with Python 3.12 and pytest 8.3.5:

```bash
PYTHONPATH=src python -m pytest --collect-only -q -p no:cacheprovider tasks/T2/tests
# -> 5 tests collected
```

`scripts/verify.sh` prints the same numbers in its summary table (`hidden` column: T2 = 5).

## Why it is well-formed

- It can be checked objectively from delivered files, with no model judgement needed.
- It concerns one purchased task, so the dispute's `taskMask` covers exactly T2.
- It is plausible: the other four tasks do meet it, and the claim reads like the other coverage and
  validity claims (C9, C11).
- Nothing else in the description is false. The other claims are backed by `scripts/verify.sh`
  (native and `--docker`) and by the bundle contents.

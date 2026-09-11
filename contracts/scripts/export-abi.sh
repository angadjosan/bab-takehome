#!/usr/bin/env bash
# Writes packages/shared/src/abi/{EnvMarket,TestUSDC}.json (bare ABI arrays).
# EnvMarket.json is the MERGED ABI of EnvMarket + EnvMarketViews: the view functions are served
# from the EnvMarket address through its delegatecall fallback, so clients use one address + one ABI.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(dirname "$HERE")"
ROOT="$(dirname "$CONTRACTS")"
export PATH="$HOME/.foundry/bin:$PATH"

cd "$CONTRACTS"
forge build >/dev/null
OUT_DIR="$ROOT/packages/shared/src/abi"
mkdir -p "$OUT_DIR"

node - "$CONTRACTS/out" "$OUT_DIR" <<'EOF'
const fs = require("node:fs");
const [outDir, abiDir] = process.argv.slice(2);
const load = (file, name) => JSON.parse(fs.readFileSync(`${outDir}/${file}/${name}.json`, "utf8")).abi;
const sig = (e) => {
  const t = (i) => (i.type.startsWith("tuple") ? `(${i.components.map(t).join(",")})${i.type.slice(5)}` : i.type);
  return `${e.type}:${e.name ?? ""}(${(e.inputs ?? []).map(t).join(",")})`;
};
const merged = [];
const seen = new Set();
for (const e of [...load("EnvMarket.sol", "EnvMarket"), ...load("EnvMarketViews.sol", "EnvMarketViews")]) {
  const k = sig(e);
  if (seen.has(k)) continue;
  seen.add(k);
  merged.push(e);
}
const write = (name, abi) => {
  fs.writeFileSync(`${abiDir}/${name}.json`, JSON.stringify(abi, null, 2) + "\n");
  console.log(`wrote ${abiDir}/${name}.json (${abi.length} entries)`);
};
write("EnvMarket", merged);
write("TestUSDC", load("TestUSDC.sol", "TestUSDC"));
EOF

#!/usr/bin/env bash
# Sell an RL environment on the live market (Base Sepolia), end to end, from your machine.
#
#   ./sell.sh <path-to-environment-dir> [--price 100] [--collateral 100] [--new-wallet] [--no-faucet] [--dry-run]
#   ./sell.sh --new-wallet                only make a seller wallet
#
# Any Base Sepolia wallet can sell. Use a key just for selling: it is your seller identity on-chain
# and the account that receives sale proceeds. Pick one:
#   --new-wallet                          make a fresh key and save it to .env in this repo (back that file up)
#   SELLER_PK=0x... ./sell.sh <dir>       use an existing key for this run only (nothing written to disk)
#   SELLER_PK=0x... in .env               use an existing key on every run
# If the wallet is short on gas or tUSDC, the app's test faucet tops it up (--no-faucet to skip).
#
#   1. check the folder layout (what `seller package` needs, and what the TEE will reject)
#   2. package locally: canonical tar, salted task/audit Merkle roots, manifest, AES-256-GCM
#   3. upload the ciphertexts to the attested TEE (keys HPKE-wrapped to its key); it rechecks everything
#   4. list on-chain: createListing, or newVersion on your existing listing of the same environment
#   5. deposit collateral only if your free stake is below one sale's collateral
#   6. preview: TEE quote -> requestPreview (you pay the fee) -> TEE run -> signed report attached on-chain
#
# Safe to re-run after a failure: finished steps are skipped. Price and collateral are in tUSDC.
# --dry-run stops after steps 1-2 (packaged in a temp folder, then deleted): no upload, no transaction.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="${APP_URL:-https://rl-env-market.vercel.app}"
EXPLORER="https://sepolia.basescan.org"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

WS="" PRICE=100 COLLATERAL=100 DRY=0 NEW_WALLET=0 FAUCET=1
while [ $# -gt 0 ]; do
  case "$1" in
    --price) PRICE="${2:-}"; shift 2 || usage 1 ;;
    --price=*) PRICE="${1#*=}"; shift ;;
    --collateral) COLLATERAL="${2:-}"; shift 2 || usage 1 ;;
    --collateral=*) COLLATERAL="${1#*=}"; shift ;;
    --dry-run) DRY=1; shift ;;
    --new-wallet) NEW_WALLET=1; shift ;;
    --no-faucet) FAUCET=0; shift ;;
    -h | --help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage 1 ;;
    *) [ -z "$WS" ] || die "give one environment folder (got '$WS' and '$1')"; WS="$1"; shift ;;
  esac
done
[ -n "$WS" ] || [ "$NEW_WALLET" = 1 ] || usage 1
for pair in "price:$PRICE" "collateral:$COLLATERAL"; do
  [[ "${pair#*:}" =~ ^[0-9]+(\.[0-9]{1,6})?$ ]] || die "--${pair%%:*} must be an amount of tUSDC, like 100 or 12.5 (got '${pair#*:}')"
done
if [ -n "$WS" ]; then
  [ -d "$WS" ] || die "'$WS' is not a folder"
  WS="$(cd "$WS" && pwd)"
fi
RERUN="./sell.sh ${WS:-<path-to-environment-dir>} --price $PRICE --collateral $COLLATERAL"
[ "$FAUCET" = 1 ] || RERUN="$RERUN --no-faucet"

# ------------------------------------------------------------------------------ prerequisites
say "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22 or newer is required (found $(node --version))"
info "node $(node --version)"

install_deps() { # dir, probe
  [ -e "$ROOT/$1/node_modules/$2" ] && return 0
  info "installing dependencies in $1/ (one time)"
  if [ -f "$ROOT/$1/package-lock.json" ]; then (cd "$ROOT/$1" && npm ci --no-audit --no-fund); else (cd "$ROOT/$1" && npm install --no-audit --no-fund); fi \
    || die "installing dependencies in $1/ failed"
}
install_deps packages/shared tar-stream
install_deps agents .bin/tsx
[ -e "$ROOT/agents/node_modules/commander" ] || install_deps agents commander
info "agent dependencies installed"

has_seller_key() {
  [[ "${SELLER_PK:-}" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] && return 0
  [ -f "$ROOT/.env" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?SELLER_PK=["'"'"']?(0x)?[0-9a-fA-F]{64}' "$ROOT/.env"
}
KEY_HELP="Run with --new-wallet to make one, or use an existing Base Sepolia key: SELLER_PK=0x... $RERUN (this run only), or a line SELLER_PK=0x... in $ROOT/.env (every run)."

if [ "$NEW_WALLET" = 1 ]; then
  has_seller_key && die "a seller key is already set (SELLER_PK in your environment or $ROOT/.env), so a new wallet would not be used. Drop --new-wallet to sell from that one, or remove it first."
  NEW_ADDR="$(cd "$ROOT/agents" && node --input-type=module -e '
import fs from "node:fs";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
const file = process.argv[1];
const pk = generatePrivateKey();
const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
fs.writeFileSync(file, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + `SELLER_PK=${pk}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(privateKeyToAddress(pk));
' "$ROOT/.env")" || die "could not create a wallet"
  info "new seller wallet $NEW_ADDR ($EXPLORER/address/$NEW_ADDR)"
  info "its key is saved as SELLER_PK in $ROOT/.env; back that file up, it is the only copy"
  if [ -z "$WS" ]; then
    info "next: $RERUN   (tops the wallet up from the test faucet)"
    exit 0
  fi
fi

if has_seller_key; then info "seller key found (SELLER_PK)"
elif [ "$DRY" = 1 ]; then warn "no seller key yet (fine for a dry run). $KEY_HELP"
else die "no seller key. $KEY_HELP"; fi

export CHAIN_ID=84532
TEE_RECORD="$ROOT/deployments/phala-tee.json"
[ -f "$TEE_RECORD" ] || die "missing $TEE_RECORD"
TEE_URL="$(node -p 'require(process.argv[1]).endpoint' "$TEE_RECORD")"
MARKET="$(node -p 'require(process.argv[1]).market' "$ROOT/deployments/84532.json")"
export TEE_URL SELLER_WORKSPACE="$WS"
unset TEE_PUBLIC_URL MARKET_ADDRESS TOKEN_ADDRESS TOKEN_ADDR DEPLOYMENTS_DIR || true
info "market $MARKET on Base Sepolia ($EXPLORER/address/$MARKET)"

# The running TEE must be the attested one on record: keys get wrapped to its encryption key.
if TEE_LINE="$(node -e '
  const [base, recFile] = process.argv.slice(1);
  const rec = require(recFile);
  (async () => {
    const h = await (await fetch(base + "/health", { signal: AbortSignal.timeout(20000) })).json();
    const bad = [];
    if (Number(h.chainId) !== 84532) bad.push(`chainId ${h.chainId}`);
    if (String(h.encPubKey).toLowerCase() !== rec.encPubKey.toLowerCase()) bad.push(`encPubKey ${h.encPubKey} != record ${rec.encPubKey}`);
    if (String(h.signer).toLowerCase() !== rec.signer.toLowerCase()) bad.push(`signer ${h.signer} != record ${rec.signer}`);
    if (bad.length) { console.error(bad.join("; ")); process.exit(2); }
    console.log(`TEE ${rec.appId.slice(0, 10)}… reachable: signer ${h.signer}, attestation ${h.attestation?.kind}, trust page ${rec.trustUrl}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
' "$TEE_URL" "$TEE_RECORD")"; then
  info "$TEE_LINE"
elif [ "$DRY" = 1 ]; then
  warn "could not confirm the TEE at $TEE_URL (not needed for a dry run)"
else
  die "the TEE at $TEE_URL is unreachable or does not match $TEE_RECORD (see the message above)"
fi

# ------------------------------------------------------------------------------ 1. layout
say "Checking the environment folder: $WS"
VERSION="$(node -e '
const fs = require("fs"), path = require("path");
const [ws, price, collateral, depFile] = process.argv.slice(1);
const errs = [], notes = [];
const st = (p) => { try { return fs.lstatSync(path.join(ws, p)); } catch { return null; } };
const isFile = (p) => !!st(p)?.isFile();
const isDir = (p) => !!st(p)?.isDirectory();
const first = (c) => c.find(isFile);
const read = (p) => fs.readFileSync(path.join(ws, p), "utf8");
const json = (p) => { try { return JSON.parse(read(p)); } catch (e) { errs.push(`${p} is not valid JSON (${e.message})`); return null; } };
const NEVER = new Set([".DS_Store", "__pycache__", ".pytest_cache", ".mypy_cache", ".git", "SEEDED_DISPUTE.md", "audit-tasks", "salts.json", "keys.json"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const dirs = (p) => (isDir(p) ? fs.readdirSync(path.join(ws, p), { withFileTypes: true }).filter((d) => d.isDirectory() && !NEVER.has(d.name)).map((d) => d.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : []);

const descF = first(["listing/description.json", "description.json"]);
const tplF = first(["listing/manifest.template.json", "manifest.template.json", "listing/manifest.json"]);
if (!descF) errs.push("missing listing/description.json (the numbered, checkable claims buyers see)");
if (!tplF) errs.push("missing listing/manifest.template.json (your manifest; <FILL...> placeholders are filled when packaging)");
for (const d of ["src", "tasks", "grader"]) if (!isDir(d)) errs.push(`missing the ${d}/ folder`);
for (const f of ["requirements.lock", "IMAGE_DIGEST"]) if (!isFile(f)) errs.push(`missing the ${f} file`);

const desc = descF ? json(descF) : null;
if (desc) {
  if (typeof desc.environmentVersion !== "string" || !desc.environmentVersion.includes("@")) errs.push(`${descF}: "environmentVersion" must look like "my-env@1.0.0"`);
  if (typeof desc.title !== "string" || !desc.title) errs.push(`${descF}: "title" is required`);
  if (desc.type !== "envmarket.description.v1" && desc.schemaVersion !== "1") errs.push(`${descF}: add "type": "envmarket.description.v1" (or "schemaVersion": "1")`);
  if (!Array.isArray(desc.claims) || desc.claims.length === 0) errs.push(`${descF}: "claims" must be a non-empty list`);
  else {
    const seen = new Set();
    desc.claims.forEach((c, i) => {
      const at = `${descF}: claim ${i + 1}`;
      if (!/^C[1-9][0-9]*$/.test(String(c?.id))) errs.push(`${at}: id must be "C1", "C2", ...`);
      if (seen.has(c?.id)) errs.push(`${at}: duplicate id ${c.id}`);
      seen.add(c?.id);
      if (typeof c?.text !== "string" || !c.text || c.text.length > 1000) errs.push(`${at}: "text" must be 1-1000 characters`);
      if (typeof c?.category !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(c.category)) errs.push(`${at}: "category" must be a short identifier like "grader" or "taskCount"`);
      if (!(typeof c?.check === "string" && c.check) && c?.checkable !== true) errs.push(`${at}: say how to check it ("check": "...") or set "checkable": true`);
    });
  }
}
const tpl = tplF ? json(tplF) : null;
if (tpl && desc) {
  if (tpl.environmentVersion && tpl.environmentVersion !== desc.environmentVersion) errs.push(`${tplF} environmentVersion ${tpl.environmentVersion} differs from ${descF} (${desc.environmentVersion})`);
  if (!["coding", "browser", "tool-use", "math", "other"].includes(tpl.environmentType)) errs.push(`${tplF}: "environmentType" must be one of coding, browser, tool-use, math, other`);
  for (const k of ["reset", "step", "grade", "close"]) if (!tpl.entrypoints?.[k]) errs.push(`${tplF}: entrypoints.${k} is missing`);
}
if (isFile("IMAGE_DIGEST")) {
  const lines = read("IMAGE_DIGEST").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const kv = Object.fromEntries(lines.map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const ref = kv.base ?? kv.ref ?? (Object.keys(kv).length === 0 ? lines[0] : undefined);
  if (!ref || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(ref)) errs.push("IMAGE_DIGEST must name an immutable image, e.g. python:3.12-slim@sha256:<64 hex> (or a line base=<that>)");
}
const checkTasks = (root, label, needTests) => {
  const ids = dirs(root);
  for (const id of ids) {
    if (!ID.test(id)) { errs.push(`${root}/${id}: task folder names may use only letters, digits, . _ - (max 128)`); continue; }
    const tj = `${root}/${id}/task.json`;
    if (!isFile(tj)) errs.push(`${tj} is missing`);
    else { const t = json(tj); if (t && t.taskId !== id) errs.push(`${tj}: "taskId" must be "${id}" (the folder name), got ${JSON.stringify(t.taskId)}`); }
    if (needTests && !isDir(`${root}/${id}/tests`)) errs.push(`${root}/${id}/tests/ (the hidden tests) is missing`);
  }
  return ids;
};
const taskIds = isDir("tasks") ? checkTasks("tasks", "purchased", true) : [];
if (isDir("tasks") && taskIds.length === 0) errs.push("tasks/ has no task folders (tasks/<taskId>/task.json + tests/)");
if (taskIds.length > 256) errs.push(`at most 256 purchased tasks (found ${taskIds.length})`);
const auditIds = checkTasks("audit-tasks", "audit", true);
for (const a of auditIds) if (taskIds.includes(a)) errs.push(`task id ${a} is in both tasks/ and audit-tasks/`);
if (tpl && Array.isArray(tpl.taskIds) && tpl.taskIds.join(",") !== taskIds.join(",")) errs.push(`${tplF} taskIds [${tpl.taskIds}] must equal the tasks/ folders [${taskIds}]`);

// The canonical archive is plain ustar: regular files and folders, ASCII paths, no symlinks.
const ENTRIES = ["src", "tasks", "grader", "solutions", "requirements.lock", "IMAGE_DIGEST", "Dockerfile.runner", ".dockerignore", "scripts", "LICENSE-ENV.md", "provenance.json", "README.md", "listing", "audit-tasks"];
let bytes = 0;
const walk = (rel) => {
  const s = st(rel);
  if (!s) return;
  if (s.isSymbolicLink()) return errs.push(`${rel} is a symlink; replace it with the real file or folder`);
  if (!/^[\x21-\x7e ]+$/.test(rel)) errs.push(`${rel}: file names must be plain ASCII`);
  if (Buffer.byteLength(rel) > 250) errs.push(`${rel}: path is too long for the archive format`);
  if (s.isDirectory()) for (const n of fs.readdirSync(path.join(ws, rel))) { if (!NEVER.has(n)) walk(`${rel}/${n}`); }
  else if (s.isFile()) bytes += s.size;
  else errs.push(`${rel} is not a regular file`);
};
for (const e of ENTRIES) walk(e);
if (bytes > 40 * 1024 * 1024) errs.push(`the environment is ${(bytes / 1048576).toFixed(1)} MB; the TEE accepts uploads up to about 40 MB`);

const toBase = (s) => { const [w, f = ""] = s.split("."); return BigInt(w) * 1000000n + BigInt((f + "000000").slice(0, 6)); };
const dep = require(depFile);
const p = BigInt(toBase(price)), c = BigInt(toBase(collateral));
if (p === 0n) errs.push("--price must be above 0");
const need = BigInt(dep.params?.caseFee ?? 0) + (p * BigInt(dep.params?.penaltyBps ?? 0)) / 10000n;
if (c < need) errs.push(`--collateral ${collateral} is below the market minimum for this price: ${Number(need) / 1e6} tUSDC (case fee + ${(dep.params?.penaltyBps ?? 0) / 100}% of the price)`);

if (errs.length) { console.error("The environment folder is not ready:\n" + errs.map((e) => "  - " + e).join("\n")); process.exit(1); }
const lic = ["LICENSE-ENV.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "listing/LICENSE", "listing/LICENSE.md", "listing/license.md"].find(isFile);
console.error([
  `    title:          ${desc.title}`,
  `    version:        ${desc.environmentVersion}`,
  `    claims:         ${desc.claims.length}`,
  `    tasks:          ${taskIds.length} purchased (${taskIds.join(", ")})`,
  `    audit tasks:    ${auditIds.length ? `${auditIds.length} (${auditIds.join(", ")}), encrypted separately, never delivered to buyers` : "none"}`,
  `    license:        ${lic ?? (tpl?.license?.id ? `${tpl.license.id} (from the manifest)` : "none")}`,
  `    size:           ${(bytes / 1024).toFixed(0)} KB`,
  `    price:          ${price} tUSDC, collateral ${collateral} tUSDC per sale`,
  ...(isFile("SEEDED_DISPUTE.md") ? ["    SEEDED_DISPUTE.md stays private (never packaged)"] : []),
].join("\n"));
console.log(desc.environmentVersion);
' "$WS" "$PRICE" "$COLLATERAL" "$ROOT/deployments/84532.json")" || die "fix the folder, then run: $RERUN --dry-run"

seller() { (cd "$ROOT/agents" && ./node_modules/.bin/tsx src/seller/cli.ts "$@"); }
step() { # description, command...
  local what="$1"; shift
  "$@" || die "$what failed (see above). Fix it and re-run: $RERUN   (finished steps are skipped)"
}

# ------------------------------------------------------------------------------ dry run
if [ "$DRY" = 1 ]; then
  say "Packaging (dry run, in a temporary folder that is deleted afterwards)"
  TMP_DATA="$(mktemp -d "${TMPDIR:-/tmp}/sell-dry.XXXXXX")"
  trap 'rm -rf "$TMP_DATA"' EXIT
  export AGENTS_DATA_DIR="$TMP_DATA"
  step "packaging" seller package --workspace "$WS" --price "$PRICE" --collateral "$COLLATERAL"
  say "Dry run passed for $VERSION"
  info "Nothing was uploaded and no transaction was sent."
  info "To list it for real: $RERUN"
  exit 0
fi

# ------------------------------------------------------------------------------ real run
SAFE="$(printf '%s' "$VERSION" | sed 's/[^A-Za-z0-9._-]/_/g')"
VDIR="${AGENTS_DATA_DIR:-$ROOT/agents/.data}/seller/$SAFE"
STATE="$VDIR/seller-state.json"
get() { # file key.path → value or empty
  node -e 'const [f, k] = process.argv.slice(1); try { const v = k.split(".").reduce((o, x) => (o == null ? undefined : o[x]), JSON.parse(require("fs").readFileSync(f, "utf8"))); if (v != null) process.stdout.write(String(v)); } catch {}' "$1" "$2"
}
base_units() { node -e 'const [w, f = ""] = process.argv[1].split("."); process.stdout.write(String(BigInt(w) * 1000000n + BigInt((f + "000000").slice(0, 6))))' "$1"; }

say "Seller account"
STATUS="$(step "reading the seller account" seller status)"
printf '%s\n' "$STATUS" | sed 's/^/    /'
SELLER_ADDR="$(printf '%s\n' "$STATUS" | awk '/^seller 0x/ {print $2; exit}')"
[ -n "$SELLER_ADDR" ] && info "$EXPLORER/address/$SELLER_ADDR"

say "Funds: gas, one sale of collateral, and the preview fee"
FUND=(fund --collateral "$COLLATERAL")
[ -z "$(get "$STATE" reportHash)" ] || FUND+=(--no-preview-fee)
[ "$FAUCET" = 0 ] || FUND+=(--faucet "$APP_URL")
step "funding the seller wallet" seller "${FUND[@]}"

say "Step 2-3: package and upload to the TEE"
if [ -n "$(get "$STATE" versionId)" ]; then
  info "already done: listed as version $(get "$STATE" versionId) (terms are fixed once listed)"
elif [ -n "$(get "$STATE" upload.uploadId)" ] && [ "$(get "$VDIR/listing-input.json" versionInput.price)" = "$(base_units "$PRICE")" ] \
  && [ "$(get "$VDIR/listing-input.json" versionInput.collateral)" = "$(base_units "$COLLATERAL")" ]; then
  info "already done: uploaded (${VDIR#"$ROOT"/}), not listed yet"
else
  info "packaging locally (fresh keys and salts; plaintext never leaves this machine)"
  step "packaging" seller package --workspace "$WS" --price "$PRICE" --collateral "$COLLATERAL" --force
  info "uploading the encrypted environment; the TEE rechecks every commitment and runs a sandboxed preflight (a minute or two)"
  step "the upload" seller upload --version "$VERSION"
fi

say "Step 4: list on Base Sepolia"
step "listing" seller list --version "$VERSION" --reuse-listing

say "Step 5: collateral"
step "the collateral deposit" seller ensure-collateral --version "$VERSION"

say "Step 6: verified preview"
if [ -n "$(get "$STATE" reportHash)" ]; then
  info "already done: report $(get "$STATE" reportHash) is attached on-chain"
else
  info "the TEE quotes the inference cost, you pay it on-chain (requestPreview), then it runs the reference"
  info "models on your sealed tasks and attaches a signed report. This usually takes several minutes."
  info "If it stops, re-run the same command: an already-paid preview is reused, never paid twice."
  step "the preview" seller preview --version "$VERSION"
fi

VID="$(get "$STATE" versionId)"
LID="$(get "$STATE" listingId)"
TX="$(get "$STATE" listTx)"
say "Done: $VERSION is for sale"
info "listing #$LID, version #$VID"
[ -n "$TX" ] && info "listing tx:    $EXPLORER/tx/$TX"
info "preview report $(get "$STATE" reportHash)"
[ -n "$SELLER_ADDR" ] && info "your sales:    $APP_URL/seller/$SELLER_ADDR"
info "listing page:  $APP_URL/listing/$VID"

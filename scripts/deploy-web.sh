#!/usr/bin/env bash
# Deploy apps/web to Vercel production from the committed HEAD (never the working tree).
#
#   scripts/deploy-web.sh                 # snapshot HEAD -> link -> sync check -> env check -> deploy -> smoke test
#   WRITE_RECORD=1 scripts/deploy-web.sh  # also rewrite deployments/web.json (commit it yourself)
#
# Env (all optional):
#   VERCEL_PROJECT   Vercel project name            (default rl-env-market)
#   VERCEL_SCOPE     Vercel team/scope slug          (default: the CLI's current scope)
#   VERCEL_LINK_DIR  an existing .vercel/ directory to copy instead of running `vercel link`
#   SNAP_DIR         where to extract the snapshot   (default: a fresh mktemp dir)
#   ALLOW_UNSYNCED=1 deploy even if apps/web/src/generated on HEAD is out of sync with deployments/
#
# Needs: git, node, curl, and a logged-in Vercel CLI. No secrets live in this script; production env
# vars are managed in Vercel (`vercel env add <NAME> production`), see apps/web/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${VERCEL_PROJECT:-rl-env-market}"
SNAP="${SNAP_DIR:-$(mktemp -d)/web-snapshot}"
REQUIRED_ENV=(NEXT_PUBLIC_CHAIN_ID NEXT_PUBLIC_RPC_URL NEXT_PUBLIC_PRIVY_APP_ID TEE_URL)
OPTIONAL_ENV=(NEXT_PUBLIC_TEE_URL NEXT_PUBLIC_PRIVY_SPONSOR_GAS NEXT_PUBLIC_PRIVY_CLIENT_ID)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v vercel >/dev/null || die "vercel CLI not found (npm i -g vercel)"
vercel whoami >/dev/null 2>&1 || die "vercel CLI is not logged in (vercel login)"
scope=(); [[ -n "${VERCEL_SCOPE:-}" ]] && scope=(--scope "$VERCEL_SCOPE")

COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
say "snapshot HEAD ${COMMIT:0:7} -> $SNAP"
[[ -z "$(git -C "$ROOT" status --porcelain -- apps/web deployments scripts/sync-web.sh)" ]] ||
  echo "note: uncommitted changes under apps/web or deployments are NOT deployed"
[[ ! -e "$SNAP" ]] || die "$SNAP already exists; pick a fresh SNAP_DIR"
mkdir -p "$SNAP"
git -C "$ROOT" archive HEAD | tar -x -C "$SNAP"

say "check apps/web/src/generated is in sync with deployments/"
cp -R "$SNAP/apps/web/src/generated" "$SNAP/.generated-committed"
bash "$SNAP/scripts/sync-web.sh" >/dev/null
if ! diff -r -q "$SNAP/.generated-committed" "$SNAP/apps/web/src/generated"; then
  [[ "${ALLOW_UNSYNCED:-}" == 1 ]] || die "generated files on HEAD are stale: run scripts/sync-web.sh and commit apps/web/src/generated (or ALLOW_UNSYNCED=1 to deploy the synced copy)"
  echo "warning: deploying freshly synced generated files that differ from HEAD"
fi
rm -rf "$SNAP/.generated-committed"

WEB="$SNAP/apps/web"
say "link $WEB to Vercel project $PROJECT"
if [[ -n "${VERCEL_LINK_DIR:-}" ]]; then
  cp -R "$VERCEL_LINK_DIR" "$WEB/.vercel"
else
  (cd "$WEB" && vercel link --yes --project "$PROJECT" ${scope[@]+"${scope[@]}"} >/dev/null)
fi
rm -f "$WEB/.env.local" "$WEB/.env" # `vercel link` may write a pulled env file (with a token); never upload it
grep -q "\"projectName\":\"$PROJECT\"" "$WEB/.vercel/project.json" || die "linked to the wrong project: $(cat "$WEB/.vercel/project.json")"

say "check production env vars"
envs="$(cd "$WEB" && vercel env ls production ${scope[@]+"${scope[@]}"} 2>/dev/null)"
missing=()
for n in "${REQUIRED_ENV[@]}"; do grep -qE "^ *$n " <<<"$envs" || missing+=("$n"); done
((${#missing[@]} == 0)) || die "missing production env var(s): ${missing[*]} (vercel env add <NAME> production)"
for n in "${OPTIONAL_ENV[@]}"; do grep -qE "^ *$n " <<<"$envs" && echo "set: $n" || echo "unset (optional): $n"; done

say "deploy to production"
DEPLOY_URL="$(cd "$WEB" && vercel deploy --prod --yes ${scope[@]+"${scope[@]}"} 2>/dev/null | grep -Eo 'https://[^ ]+\.vercel\.app' | tail -1)"
[[ -n "$DEPLOY_URL" ]] || die "vercel deploy did not print a deployment URL"
echo "deployment: $DEPLOY_URL"
PROD_URL="https://$PROJECT.vercel.app"

say "smoke test $PROD_URL"
fail=0
for p in / /activity /jurors /api/tee/health; do
  code="$(curl -s -o /dev/null -m 60 -w '%{http_code}' "$PROD_URL$p")"
  printf '%-18s %s\n' "$p" "$code"; [[ "$code" == 200 ]] || fail=1
done
curl -s -m 60 "$PROD_URL/api/tee/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);console.log(`tee signer ${h.signer} · ${h.attestation?.kind}`)})' || fail=1
curl -s -m 90 "$PROD_URL/api/attestation/verify" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);for(const c of v.checks??[])console.log(`  ${c.ok===true?"ok  ":c.ok===false?"FAIL":"n/a "} ${c.id}`);console.log(`attestation verify: ${v.ok?"verified":"NOT verified"}`);process.exit(v.ok?0:1)})' || fail=1

if [[ "${WRITE_RECORD:-}" == 1 ]]; then
  node -e '
    const fs = require("fs"); const [f, url, dep, commit] = process.argv.slice(1);
    const r = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    Object.assign(r, { url, deploymentUrl: dep, commit, deployedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    fs.writeFileSync(f, JSON.stringify(r, null, 2) + "\n");
  ' "$ROOT/deployments/web.json" "$PROD_URL" "$DEPLOY_URL" "$COMMIT"
  echo "wrote deployments/web.json (commit it)"
fi

((fail == 0)) || die "smoke test failed (deployment $DEPLOY_URL is live anyway)"
say "done: $PROD_URL <- ${COMMIT:0:7}"

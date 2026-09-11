#!/usr/bin/env bash
# Deploy services/jurors-vercel (the three AI jurors as Vercel Functions + Workflow) to Vercel
# production from the committed HEAD (never the working tree).
#
#   scripts/deploy-jurors.sh                 # snapshot HEAD -> vendor check -> tests -> link -> env check -> deploy -> smoke test
#   WRITE_RECORD=1 scripts/deploy-jurors.sh  # also rewrite deployments/jurors.json (commit it yourself)
#
# Env (all optional):
#   VERCEL_PROJECT   Vercel project name            (default rl-env-market-jurors)
#   VERCEL_SCOPE     Vercel team/scope slug          (default: the CLI's current scope)
#   VERCEL_LINK_DIR  an existing .vercel/ directory to copy instead of running `vercel link`
#   SNAP_DIR         where to extract the snapshot   (default: a fresh mktemp dir)
#   SKIP_TESTS=1     skip `npm ci && npm test` in the snapshot
#
# Secrets never pass through this script. Production env vars live in Vercel as *sensitive* vars
# (see services/jurors-vercel/README.md for the one-time `vercel env add ... --sensitive` setup).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${VERCEL_PROJECT:-rl-env-market-jurors}"
SNAP="${SNAP_DIR:-$(mktemp -d)/jurors-snapshot}"
REQUIRED_ENV=(JUROR1_PK JUROR2_PK JUROR3_PK FIREWORKS_API_KEY CRON_SECRET)
OPTIONAL_ENV=(JURORS_ENABLED RPC_URL TEE_URL KEEPER_JUROR ALLOWED_ORIGINS)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v vercel >/dev/null || die "vercel CLI not found (npm i -g vercel)"
vercel whoami >/dev/null 2>&1 || die "vercel CLI is not logged in (vercel login)"
scope=(); [[ -n "${VERCEL_SCOPE:-}" ]] && scope=(--scope "$VERCEL_SCOPE")

COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
say "snapshot HEAD ${COMMIT:0:7} -> $SNAP"
[[ -z "$(git -C "$ROOT" status --porcelain -- services/jurors-vercel services/jurors/src services/jurors/prompts packages/shared/src)" ]] ||
  echo "note: uncommitted changes under services/jurors-vercel or its vendored sources are NOT deployed"
[[ ! -e "$SNAP" ]] || die "$SNAP already exists; pick a fresh SNAP_DIR"
mkdir -p "$SNAP"
git -C "$ROOT" archive HEAD | tar -x -C "$SNAP"
APP="$SNAP/services/jurors-vercel"

say "check src/vendor matches services/jurors + packages/shared on HEAD"
node "$APP/scripts/sync-vendor.mjs" --check

if [[ "${SKIP_TESTS:-}" != 1 ]]; then
  say "npm ci && npm test (snapshot)"
  (cd "$APP" && npm ci --no-audit --no-fund >/dev/null && npm test)
  rm -rf "$APP/node_modules" "$APP/.next" "$APP/src/app/.well-known"
fi

say "link $APP to Vercel project $PROJECT"
if [[ -n "${VERCEL_LINK_DIR:-}" ]]; then
  cp -R "$VERCEL_LINK_DIR" "$APP/.vercel"
else
  (cd "$APP" && vercel link --yes --project "$PROJECT" ${scope[@]+"${scope[@]}"} >/dev/null)
fi
rm -f "$APP/.env.local" "$APP/.env" # `vercel link` may write a pulled env file; never upload it
grep -q "\"projectName\":\"$PROJECT\"" "$APP/.vercel/project.json" || die "linked to the wrong project: $(cat "$APP/.vercel/project.json")"

say "check production env vars (names only)"
envs="$(cd "$APP" && vercel env ls production ${scope[@]+"${scope[@]}"} 2>/dev/null)"
missing=()
for n in "${REQUIRED_ENV[@]}"; do grep -qE "^ *$n " <<<"$envs" || missing+=("$n"); done
((${#missing[@]} == 0)) || die "missing production env var(s): ${missing[*]} (see services/jurors-vercel/README.md)"
for n in "${OPTIONAL_ENV[@]}"; do grep -qE "^ *$n " <<<"$envs" && echo "set: $n" || echo "unset (optional): $n"; done

say "deploy to production"
DEPLOY_URL="$(cd "$APP" && vercel deploy --prod --yes ${scope[@]+"${scope[@]}"} 2>/dev/null | grep -Eo 'https://[^ ]+\.vercel\.app' | tail -1)"
[[ -n "$DEPLOY_URL" ]] || die "vercel deploy did not print a deployment URL"
echo "deployment: $DEPLOY_URL"
PROD_URL="${PROD_URL:-https://$PROJECT.vercel.app}"

say "smoke test $PROD_URL"
fail=0
health="$(curl -s -m 60 "$PROD_URL/api/health")"
node -e 'const h=JSON.parse(process.argv[1]);console.log(`enabled=${h.enabled} chain=${h.chainId} market=${h.market} nextDisputeId=${h.nextDisputeId}`);for(const j of h.jurors??[])console.log(`  juror${j.index} ${j.address} approved=${j.approved} stake=${j.stake.total} free=${j.stake.free} claimable=${j.claimable} gas=${j.gasEth} ${j.model}`);process.exit(h.ok&&h.jurors?.length===3?0:1)' "$health" || fail=1
wake="$(curl -s -m 60 -X POST -H 'content-type: application/json' "$PROD_URL/api/wake" -d '{}')"
node -e 'const w=JSON.parse(process.argv[1]);console.log(`wake: ${w.message}`);for(const d of w.disputes??[])console.log(`  #${d.disputeId} ${d.status} r${d.round}: ${d.action}${d.runId?` ${d.runId}`:""}`);process.exit(w.ok?0:1)' "$wake" || fail=1

if [[ "${WRITE_RECORD:-}" == 1 ]]; then
  node -e '
    const fs = require("fs"); const [f, url, dep, commit, project] = process.argv.slice(1);
    const r = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    Object.assign(r, { url, deploymentUrl: dep, project, commit, deployedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
    fs.writeFileSync(f, JSON.stringify(r, null, 2) + "\n");
  ' "$ROOT/deployments/jurors.json" "$PROD_URL" "$DEPLOY_URL" "$COMMIT" "$PROJECT"
  echo "wrote deployments/jurors.json (commit it)"
fi

((fail == 0)) || die "smoke test failed (deployment $DEPLOY_URL is live anyway)"
say "done: $PROD_URL <- ${COMMIT:0:7}"

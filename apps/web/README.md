# RL Environment Market — web app

Next.js (App Router) front end for the market in `docs/RL_ENV_MARKET.md`. Everything it shows is read
live from the EnvMarket contract and the TEE service; hashes, EIP-712 signatures, key unwrapping and
decryption are checked in the browser. There is no mock data path.

## Run

```bash
# from the repo root: copy ABIs + deployment addresses into src/generated/
./scripts/sync-web.sh

cd apps/web
npm install
NEXT_PUBLIC_TEE_URL=https://<tee-host> npm run dev     # http://localhost:3000
npm run build && npm run lint
```

If `deployments/<chainId>.json` does not exist yet (and no `NEXT_PUBLIC_MARKET_ADDRESS` is set), the app
renders a "not deployed on this chain" state instead of listings.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `8453` | 8453 Base mainnet, 84532 Base Sepolia, 31337 local Anvil |
| `NEXT_PUBLIC_RPC_URL` | public RPC for the chain | JSON-RPC endpoint (log reads are chunked to 9k blocks) |
| `NEXT_PUBLIC_TEE_URL` | none | TEE service base URL (see "TEE API used" below) |
| `NEXT_PUBLIC_MARKET_ADDRESS` | from the synced deployment | Overrides the deployment file: market address (with `NEXT_PUBLIC_START_BLOCK`, optional `NEXT_PUBLIC_TOKEN_ADDRESS`). Used for throwaway local chains so they never land in `src/generated/` |

Contract addresses and the log start block come from the synced deployment file (or the override). The
payment token is read from the market's `token()`, and its symbol/decimals from the token itself. The
faucet button only appears when the token has `faucet()` (local TestUSDC).

## Wallets

Browser wallets (injected, Coinbase) and a **burner key** option: paste the private key of a
throwaway wallet ("Use a burner key" in the wallet menu or any "connect" prompt). It is a real wallet
on whatever chain the app runs on — a wagmi connector backed by a viem local account that signs in
the page — but the key sits in this tab's sessionStorage and signs without a confirmation prompt, so
use it only for wallets with tiny balances. Several keys can be added and switched between from the
wallet menu, which lets one browser act as buyer, second buyer, seller, juror and observer.

## Routes

- `/` — listings with in-browser description hash checks, seller cold-start badge, stake, ratings, disputes
- `/listing/[id]` — description and claims, signed preview report (hash, strict schema, EIP-712 signer, runner role, attestation), preview fee escrow, manifest, commitments, terms, buy flow
- `/purchase/[id]` — timeline with deadlines, download/verify/decrypt, dispute form (evidence uploaded privately to the TEE before `openDispute`), finalize, refund-undelivered, rating, settlement, withdraw
- `/dispute/[id]` — claim, jury draw (on-chain randomness), commit/reveal per seat, **your seat** (case packet via signed challenge, manual commit/reveal with a locally stored salt), published juror rationales (hash-checked against seat/vote/commitment), mechanical findings (hash = on-chain `findingsHash`), select / tally / verifier-timeout keeper buttons, payouts
- `/seller/[address]` — seller dashboard: collateral deposit/withdraw (total/reserved/available), open sales with finalize / refund-undelivered, per-version preview request (TEE quote → approve → `requestPreview`), start run, reclaim fee; reputation, counterparties, sales and purchases
- `/jurors` — approved juror pool with total/locked/free stake and eligibility; deposit/withdraw your stake; seats you were drawn for
- `/activity` — every market event with explorer links
- `/keys` — buyer X25519 encryption keys held in this browser
- `/how-it-works` — trust assumptions, what is and isn't proven, live parameters

Claimable balances (refunds, returned bonds, seller proceeds, juror rewards; pull payments) show in
the wallet menu and as a banner with a **Withdraw** button.

## TEE API used

From `services/tee/src/server.ts`: `GET /health`, `GET /attestation`, `GET /reports/:versionId` (200
signed report with `reportJson`, 202 while running, 500 failed), `GET /blobs/:sha256`, `PUT /blobs`
(rating comments), `GET /deliveries/:purchaseId` (served once Delivered on-chain), `POST
/evidence-upload` (`{content}` or `{base64}` → `evidenceHash`), `POST /evidence/:disputeId` (juror case
packet, EIP-191 challenge), `GET /findings/:disputeId`, `GET /preview/quote/:versionId`, `POST
/preview/:versionId?async=1`. The service sends permissive CORS headers so the browser can call it
directly.

## Local full-stack testing

`scripts/local-stack.sh` (repo root) brings up everything on a private anvil chain and keeps it in the
foreground; Ctrl-C stops exactly what it started:

1. anvil on `ANVIL_PORT` (default 8546), `contracts/scripts/deploy.sh anvil` (TestUSDC minted to the
   demo actors, jurors approved), TEE signer granted runner/relay/verifier;
2. `scripts/sync-web.sh` (ABIs only; the shared `deployments/31337.json` is restored afterwards);
3. the TEE service in local-dev mode on `TEE_PORT` (8788) — reports say `attestation.kind = none-local-dev`;
4. the seller agent packages and uploads `seller-workspace/py-repair-kit`, lists it, deposits
   collateral, pays the TEE's preview quote (`requestPreview`), and the TEE runs the real preview on
   Fireworks (several minutes; `SKIP_PREVIEW=1` to skip);
5. all three jurors register and stake; `JURORS=1,2` runs agents for only some of them, so the third
   can be voted manually in the dispute page;
6. `next dev` on `WEB_PORT` (3100) with `NEXT_PUBLIC_*` pointing at this chain (also written to
   `.data/local-stack/web.env` for `npm run build`/`start`).

```bash
scripts/local-stack.sh                      # needs foundry, node 22, docker, and the repo .env keys
JURORS=1,2 WEB_PORT=3200 scripts/local-stack.sh
set -a; . .data/local-stack/web.env; set +a; (cd apps/web && npm run build && npx next start -p 3100)
```

It prints the burner keys to use by **.env variable name** (never the keys): `SELLER_PK`, `BUYER_PK`,
`BUYER2_PK`, `JUROR1_PK`…`JUROR3_PK`, and `DEPLOYER_PK` for an observer/keeper. Re-running it is safe:
the previous run's processes (recorded in `.data/local-stack/pids` by pid and start time) are stopped,
ports held by anything else are refused, and each run starts a fresh chain. Logs:
`.data/local-stack/logs/{anvil,deploy,tee,seller,jurors,web}.log`; juror rationale hashes appear there as
`published rationale … sha256 0x…` (paste them into the dispute page). Windows are the demo values
(challenge 300 s, delivery 600 s); to skip ahead on anvil:
`cast rpc evm_increaseTime 301 --rpc-url http://127.0.0.1:8546 && cast rpc evm_mine --rpc-url http://127.0.0.1:8546`.

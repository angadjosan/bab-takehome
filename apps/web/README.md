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
| `NEXT_PUBLIC_CHAIN_ID` | `84532` | 84532 Base Sepolia (the public testnet deployment, TestUSDC with a faucet), 31337 local Anvil; 8453 Base mainnet stays supported but unused |
| `NEXT_PUBLIC_RPC_URL` | public RPC for the chain | JSON-RPC endpoint (log reads are chunked to 9k blocks) |
| `NEXT_PUBLIC_TEE_URL` | none | TEE service base URL, used directly by the browser only when it is `https://` (see "TEE API used" below). Otherwise the browser calls the same-origin proxy `/api/tee/…` |
| `TEE_URL` | `NEXT_PUBLIC_TEE_URL` | **Server-only.** Upstream for the `/api/tee/[...path]` proxy, e.g. the EigenCompute app's `http://<ip>:8080`. The proxy forwards only the TEE paths the app uses (health, attestation, protocol, reports, blobs, deliveries, findings, evidence-upload, juror evidence, preview quote/start), caps request bodies, times out after 55 s and marks private responses `no-store`. It is not trusted for integrity: the browser checks every document against its on-chain hash and every signature itself |
| `NEXT_PUBLIC_MARKET_ADDRESS` | from the synced deployment | Overrides the deployment file: market address (with `NEXT_PUBLIC_START_BLOCK`, optional `NEXT_PUBLIC_TOKEN_ADDRESS`). Used for throwaway local chains so they never land in `src/generated/` |

Contract addresses and the log start block come from the synced deployment file (or the override). The
payment token is read from the market's `token()`, and its symbol/decimals from the token itself.
On testnets a banner under the header says the token has no value, offers the TestUSDC `faucet()`
(rate-limited on-chain; it shows when the connected wallet can use it again) and links to Base Sepolia
ETH faucets for gas, so a reviewer can go connect → faucet → buy → decrypt → dispute → finalize → rate.
Attestation links go to the EigenCompute verify dashboard (`verify-sepolia.eigencloud.xyz` on testnet)
when the report carries no `verifyUrl` of its own.

## Wallets and payments (Privy)

All wallet and payment UX goes through [Privy](https://docs.privy.io) (`@privy-io/react-auth` +
`@privy-io/wagmi`): log in with email, Google or an external wallet; users without a wallet get an
embedded EVM wallet on Base Sepolia at login. Every contract write (faucet, approve, buy,
requestPreview, openDispute, commit/reveal, finalize, tally, rate, withdraw, collateral/stake
deposits) is a wagmi call on the active Privy wallet. The wallet menu shows the active wallet, the
embedded wallet with **Export wallet** (Privy's `exportWallet`; the key is shown on Privy's origin,
never this app's), token / ETH / claimable balances, the faucet and withdraw.

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app id (Dashboard → App settings). Unset: the app builds and runs with browser wallets only and shows a setup notice. |
| `NEXT_PUBLIC_PRIVY_CLIENT_ID` | Optional app client id (Dashboard → App settings → Clients), for per-environment settings. |
| `NEXT_PUBLIC_PRIVY_SPONSOR_GAS` | `1` sends writes from the **embedded** wallet through Privy's native gas sponsorship (`useSendTransaction(…, {sponsor: true})`), so a first-time reviewer needs no ETH. External wallets always pay their own gas. |

Privy dashboard settings (https://dashboard.privy.io):

1. **App settings → Domains / allowed origins:** `http://localhost:3000` (and `http://localhost:3100` for
   `scripts/local-stack.sh`) plus the Vercel production and preview domains.
2. **User management → Authentication → Login methods:** Email, Google, External wallets (EVM).
3. **Wallet infrastructure → Embedded wallets:** EVM enabled, create on login for users without wallets
   (the code also sets `createOnLogin: "users-without-wallets"`).
4. **Chains:** the app passes Base Sepolia (84532) as `defaultChain`/`supportedChains`; nothing to add in
   the dashboard unless it restricts networks.
5. **Gas sponsorship** (for `NEXT_PUBLIC_PRIVY_SPONSOR_GAS=1`): Dashboard → Gas sponsorship → **App
   pays**, enable **Base Sepolia**, and make sure embedded wallets use **TEE execution** (Privy requires
   it for native EVM sponsorship; sponsored wallets are upgraded with EIP-7702 and a Privy paymaster
   pays). Keep the flag off until this is enabled, or sponsored sends fail.
6. **Test accounts** for automated browser tests: User management → Authentication → **Advanced** →
   *Enable test accounts*. Log in with the listed `test-XXXX@privy.io` email and its fixed `XXXXXX`
   OTP exactly (development apps only).

### Buyer decryption key

Buyers never generate or back up a key. At the first purchase the wallet signs the fixed message
`EnvMarket encryption key v1 for <address> on <chainId>`; the X25519 secret is HKDF-SHA256 of that
signature and its public half goes into `buy()`. Standard secp256k1 signing (viem / noble, as used by
local accounts and browser wallets) uses RFC 6979 deterministic nonces, so signing again on any device
re-derives the same key (checked: two signatures and derived keys are identical). Privy's docs don't
state the embedded wallet's nonce scheme, so the derived key is also cached in this browser; the
purchase page uses the cached key if present and otherwise asks for one signature, and says so if a
re-derived key doesn't match the purchase. Verified end to end on anvil: burner buy → relay delivery
→ automatic decryption → "Download environment", sha256 of the file = on-chain `bundleHash`.

### Burner keys (dev tool only)

On the local anvil chain, or with `?dev=1` in the URL (remembered for the tab, `?dev=0` turns it off),
the app switches to plain wagmi with browser wallets plus a **burner key** connector: paste the private
key of a throwaway wallet and it signs in the page with a viem local account. The key sits in this tab's
sessionStorage and signs without a prompt, so use it only for wallets with tiny balances. Several keys
can be added and switched between, which lets one browser act as buyer, second buyer, seller, juror
and observer.

## Routes

- `/` — listings with in-browser description hash checks, seller cold-start badge, stake, ratings, disputes
- `/listing/[id]` — description and claims, signed preview report (hash, strict schema, EIP-712 signer, runner role, attestation), preview fee escrow, manifest, commitments, terms, buy flow
- `/purchase/[id]` — timeline with deadlines, download/verify/decrypt, dispute form (evidence uploaded privately to the TEE before `openDispute`), finalize, refund-undelivered, rating, settlement, withdraw
- `/dispute/[id]` — claim, jury draw (on-chain randomness), commit/reveal per seat, **your seat** (case packet via signed challenge, manual commit/reveal with a locally stored salt), published juror rationales (hash-checked against seat/vote/commitment), mechanical findings (hash = on-chain `findingsHash`), select / tally / verifier-timeout keeper buttons, payouts
- `/seller/[address]` — seller dashboard: collateral deposit/withdraw (total/reserved/available), open sales with finalize / refund-undelivered, per-version preview request (TEE quote → approve → `requestPreview`), start run, reclaim fee; reputation, counterparties, sales and purchases
- `/jurors` — approved juror pool with total/locked/free stake and eligibility; deposit/withdraw your stake; seats you were drawn for
- `/activity` — every market event with explorer links
- `/keys` — buyer X25519 encryption keys held in this browser

Trust disclosures live where they apply (a one-line note on each screen plus a collapsed Details
panel with the evidence); the footer links to the repository README for the full trust model.

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
`.data/local-stack/logs/{anvil,deploy,tee,seller,jurors,web}.log`. Jurors publish their screened
rationales to the TEE's `POST /rationales/:disputeId` (juror-signed, accepted only after the juror's
reveal is on-chain); the dispute page lists them automatically from `GET /rationales/:disputeId` and
re-checks each against the chain. Windows are the demo values
(challenge 300 s, delivery 600 s); to skip ahead on anvil:
`cast rpc evm_increaseTime 301 --rpc-url http://127.0.0.1:8546 && cast rpc evm_mine --rpc-url http://127.0.0.1:8546`.

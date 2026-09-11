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

If `deployments/<chainId>.json` does not exist yet, the app renders a "not deployed on this chain"
state instead of listings.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `8453` | 8453 Base mainnet, 84532 Base Sepolia, 31337 local Anvil |
| `NEXT_PUBLIC_RPC_URL` | public RPC for the chain | JSON-RPC endpoint (log reads are chunked to 9k blocks) |
| `NEXT_PUBLIC_TEE_URL` | none | TEE service base URL (`/health`, `/attestation`, `/reports/:id`, `/blobs/:sha256`, `/deliveries/:id`) |

Contract addresses and the log start block come from the synced deployment file. The payment token is
read from the market's `token()`, and its symbol/decimals from the token itself. The faucet button only
appears when the token has `faucet()` (local TestUSDC).

## Routes

- `/` — listings with in-browser description hash checks, seller cold-start badge, stake, ratings, disputes
- `/listing/[id]` — description and claims, signed preview report (hash, signer, runner role, attestation), manifest, commitments, terms, buy flow
- `/purchase/[id]` — timeline with deadlines, download/verify/decrypt, dispute form, finalize, refund-undelivered, rating, settlement
- `/dispute/[id]` — claim, jury draw (on-chain randomness), commit/reveal per seat, tally, mechanical findings, payouts
- `/seller/[address]` — stake, qualifying transactions, money-weighted score, counterparty concentration, sales and purchases
- `/activity` — every market event with explorer links
- `/keys` — buyer X25519 encryption keys held in this browser
- `/how-it-works` — trust assumptions, what is and isn't proven, live parameters

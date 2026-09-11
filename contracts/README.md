# EnvMarket contracts

Foundry project for the RL Environment Market (see `docs/BUILD_SPEC.md` → "Contract").

| File | What |
|---|---|
| `src/EnvMarket.sol` | The market: listings/versions, collateral, escrow, delivery receipts, disputes (mechanical + juror commit-reveal), settlement, reputation, pull payments. |
| `src/EnvMarketStorage.sol` | Shared types, storage layout and errors (first base of both contracts so slots line up). |
| `src/EnvMarketViews.sol` | Read-only functions, split out for the EIP-170 24 KB limit. **Called on the EnvMarket address**: its `fallback()` delegatecalls this module. |
| `src/TestUSDC.sol` | 6-decimal test token with owner mint + 24h faucet. **Local anvil only**; Base mainnet uses real USDC. |
| `script/MarketParams.sol` | `demo()` and `mainnet()` market-param sets. |
| `script/Deploy.s.sol` | Deploy script (views + market, TestUSDC only on 31337), roles, jurors. |
| `scripts/deploy.sh` | Wrapper: reads repo-root `.env`, runs the script, writes `deployments/<chainId>.json`. |
| `scripts/export-abi.sh` | Writes `packages/shared/src/abi/EnvMarket.json` (merged market + views ABI) and `TestUSDC.json`. |

## Setup

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
npm ci            # vendors OpenZeppelin 5.6.1 + forge-std 1.9.7 into node_modules (see remappings)
forge build --sizes
forge test        # 45 tests; fork tests are skipped unless BASE_RPC is set
BASE_RPC=https://mainnet.base.org forge test --mc ForkUSDC   # real Base USDC on a fork
```

## Deploy

```bash
anvil &                                  # local
contracts/scripts/deploy.sh              # → deployments/31337.json (TestUSDC + demo params)

# Base mainnet (chainId 8453, real USDC, mainnet params). Refuses without the confirmation flag.
TOKEN_ADDR=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 CONFIRM_MAINNET=yes contracts/scripts/deploy.sh base
```

Env (repo-root `.env`): `DEPLOYER_PK` (owner), `TOKEN_ADDR`, `PARAM_SET` (`demo`|`mainnet`, default
by chain), `RUNNER_ADDR` / `RELAY_ADDR` / `VERIFIER_ADDR` (comma-separated), `JUROR1..3_ADDR`,
`BASE_RPC`, optional `BASESCAN_API_KEY` (adds `--verify`). On anvil, the deployer is topped up with
test ETH and `SELLER/BUYER/BUYER2/JUROR*_ADDR` get 10,000 tUSDC. Roles can be added later by the
owner (`setRunner/setRelay/setVerifier/approveJuror`), e.g. once the EigenCompute app's KMS signer
address is known.

`deployments/<chainId>.json`: `{chainId, market, token, views, startBlock, deployer, owner,
tokenSymbol, tokenDecimals, testToken, params, preview, deployedAt, txs}`. Params are read back from the
chain (amounts in 6-decimal base units). `preview = {feeRecipient, minFee, timeout}` is the
seller-paid preview config: `PREVIEW_FEE_RECIPIENT` (default: the deployer, i.e. the operator
treasury that pays the inference bill; it collects with `withdraw()`), `MIN_PREVIEW_FEE` (default 50000 = 0.05 USDC with mainnet params, 1 tUSDC with demo
params), `PREVIEW_TIMEOUT` (default 3600 s).

## Things clients must know

- **One address, one ABI.** Use `EnvMarket.json` (merged) against the EnvMarket address for
  everything, including views (`getVersion`, `getPurchase`, `getDispute`, `sellerStake`,
  `jurorInfo`, `quoteDispute`, `sellerScore`, ...).
- **Pull payments.** Settlement never pushes tokens. Refunds, returned bonds, seller proceeds and
  juror rewards are credited to `claimable(addr)` (event `Credited`), then withdrawn with
  `withdraw()`. That way a USDC-blacklisted address can't block settlement for anyone else.
- **Juror votes:** `commitment = keccak256(abi.encode(disputeId, round, uint8(verdict), salt, juror))`
  (`commitmentFor(...)` computes it). Reveal opens after `commitDeadline`, or as soon as every seat
  of the round has committed.
- **Signatures** are EIP-712, domain `EnvMarket`/`1`. `previewReportDigest`,
  `deliveryReceiptDigest` and `mechanicalFindingDigest` return the exact digest to sign.
- **Sellers pay for previews.** `attachReport` reverts `PreviewNotPaid()` unless the version's seller
  first called `requestPreview(versionId, fee, quoteHash)` (fee ≥ `minPreviewFee()`, pulled with
  `transferFrom`, so approve first). Attaching releases the fee to `claimable(previewFeeRecipient())`.
  If no report is attached by `previewDeadline(versionId)`, the seller may `reclaimPreviewFee`, then
  request again, paying at least the reclaimed fee. `previewInfo(versionId) → (fee, paidAt, quoteHash, released, reclaimed)`.
- **Accounting invariant** (tested after every scenario and under fuzzing):
  `balanceOf(market) == totalEscrow + totalCollateral + totalBonds + totalJurorStake + treasury + reserve + totalClaimable + totalPreviewFees`.

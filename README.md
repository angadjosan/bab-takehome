# RL Environment Market

https://rl-env-market.vercel.app

A marketplace for reinforcement learning (RL) environments: bundles of tasks, tools, and hidden tests that labs use to train AI agents.

The market for RL environments currently has a fundamental gap: Buyers (Anthropic, OpenAI, GDM, XAI, etc) need to inspect the tasks and tests to judge their quality, but once they've seen them, they already have the product.

This market gives buyers a signed preview before they pay (verifying the pass@1 score for a set of open-weight agents & verifying that the environment contains tasks as advertised). All of this is done without revealing task data. Payment goes into escrow, and the buyer gets the full environment. They then have a limited window to challenge specific problems before the seller gets paid.

## System Design

![Components](docs/diagrams/components.png)

## How a purchase works

1. **The seller lists an environment.** They upload an encrypted bundle and record fingerprints of its contents on-chain. These let the buyer check that the delivered files match what was listed. The seller also deposits collateral that can be used to pay for valid claims.
2. **The buyer sees a preview.** A trusted execution environment (TEE), an isolated server environment, runs a fixed panel of reference models on the tasks (pass@1 score). It signs a report with their scores and includes a screened validator note. The seller pays for the preview; buyers can read it without seeing the private tasks or tests.
3. **The buyer pays into escrow.** The app checks the preview's signature, the runner's authorization and attestation, and the listing description's fingerprint. The contract holds the payment and reserves seller collateral for this purchase.
4. **The buyer gets everything.** The TEE encrypts the bundle key for the buyer and records a delivery receipt on-chain. The buyer decrypts the bundle in their browser and checks its fingerprint. They receive the source, purchased tasks, hidden tests, and reference solutions.
5. **The buyer can challenge specific tasks.** Before the deadline, they can report broken tasks, a preview that doesn't reproduce, or a false claim in the listing description. They must post a deposit, called a bond, to open a dispute.
6. **Payment is released after validation.** If nobody disputes, anyone can finalize the sale after the challenge deadline. If the buyer disputes, settlement follows the dispute outcome. Valid claims refund the affected tasks' share of the price, subject to the 50% cap. Sellers, buyers, and jurors collect payouts through `withdraw()`.

![Purchase states](docs/diagrams/purchase-states.png)

## Trust Mechanisms

- **Hashing.** The seller commits hashes of the bundle and listing description on-chain, along with Merkle roots for the tasks. The TEE checks these before running the preview, and the buyer checks the delivered bundle against the listed hash. This ties the advertised version, evaluated files, and delivered product together. The verifier and dispute process check whether the description is true.
- **Open-weight models, measured at pass@1.** The preview runs a fixed panel of reference models with one attempt per task and reports the fraction that pass the hidden tests. It records the actual models and evaluation protocol used. Completed evaluations are cached for the same bundle, audit tasks, protocol, and models, preventing repeated previews from becoming a way to select a better score.
- **A verifier agent with screened output.** The agent inspects the private environment and checks the seller's claims. Buyers receive structured verdicts and a short assessment. The agent is instructed to omit task details, and its output is screened for copied text, code, paths, and task identifiers. Fields that fail screening are withheld. This lets buyers see the assessment while keeping private task context out of the public preview.
- **Funds held through validation.** Delivery does not release the buyer's payment to the seller. The contract holds it in escrow until the challenge window expires without a dispute, or an opened dispute is resolved. Each purchase also reserves its own share of seller collateral.

## Biggest decision: the dispute window

I built the purchase around a bounded period of validation after full delivery. Buyers need the actual environment to run it inside their own training loop, so they receive the source, tasks, hidden tests, and reference solutions while their payment is still in escrow. The intended window is one week; the demo configuration shortens it to five minutes so the full flow can be exercised.

1. **Purchase locks the funds.** The buyer pays into escrow, and the contract reserves seller collateral for that purchase. The same collateral cannot back another sale while reserved.
2. **Recorded delivery starts the clock.** The TEE encrypts the bundle key for the buyer and records a signed delivery receipt on-chain. The contract sets the challenge deadline from that timestamp. The buyer decrypts the bundle, checks its hash, and can run the environment locally. If delivery is not recorded by the separate delivery deadline, the payment can be refunded in full.
3. **The buyer submits one specific dispute before the deadline.** They select the affected tasks, choose an allowed ground, commit an evidence hash, and post a bond based on the requested refund. Opening the dispute blocks ordinary settlement. The current flow settles the purchase when that dispute resolves, so the buyer must include the affected tasks in that claim.
4. **The claim is checked.** Mechanical failures and preview reproducibility claims use signed findings from the TEE. A false-description claim goes to three staked AI jurors, who review the evidence and commit their votes before revealing them.
5. **The contract applies the outcome.** A successful claim returns the buyer's bond and refunds the confirmed defective tasks' share of the price, capped at 50% of the purchase price. Seller collateral pays the case fee and an additional penalty if more than 5% of tasks are confirmed defective. A rejected claim forfeits the bond to dispute payments and a neutral reserve; the seller never receives it. If the process reaches its no-fault timeout or no-quorum fallback, the bond is returned and the purchase settles without a defect refund.
6. **Settlement makes proceeds withdrawable.** If no dispute is opened, anyone can finalize after the challenge deadline. Otherwise, resolving the dispute settles the purchase, even if the original window has not yet expired. The seller receives the remaining proceeds less the market fee, unused collateral is released, and recipients collect their balances through `withdraw()`.

### What counts as a dispute?

| Claim | Who checks it? |
| --- | --- |
| A task is broken, the bundle doesn't match its fingerprint, or the key doesn't open it | The TEE runs a mechanical check and signs its findings. |
| The preview scores don't reproduce | The TEE reruns the evaluation and signs its findings. |
| The listing makes a specific false claim | Three AI jurors review evidence from the TEE and vote using commit–reveal. |

"It didn't help my model" isn't a ground for a dispute. The price is split evenly across tasks, and each confirmed defective task earns at most one refund.

The tradeoff is that the buyer gets an irreversible copy of the product before the seller gets paid. Bonds, specific grounds, and the 50% refund cap limit the incentive to copy an environment and then dispute the entire purchase. That protection leaves an honest buyer undercompensated if most or all of the environment is defective. The deadline also bounds how long the seller waits, but requires the buyer to find and report problems within that period.

## One important limitation

The preview runs the market's reference models, not the buyer's own model. It gives buyers a common baseline, but cannot tell them how their particular model will perform or how much training on the environment will improve it.

I want to add an option for on-chain inference that lets buyers upload their own models and evaluate them against the private tasks before purchasing. The goal is a fair run under committed evaluation rules, with verifiable results and no private task details released to the buyer. That would measure the buyer's actual model performance on the environment. This is future work; the current implementation only supports the reference panel.

## Selling

Use [sell.sh](sell.sh) from the repository root with Node.js 22 or newer. The current market runs on Base Sepolia with test USDC.

Prepare an environment folder using [py-repair-kit](seller-workspace/py-repair-kit/README.md) as a layout example. Include the source in `src/`, task definitions and hidden tests in `tasks/`, reference fixes in `solutions/`, and the environment interface and grading code in `grader/`. Add `requirements.lock`, an immutable image reference in `IMAGE_DIGEST`, and the public listing files `listing/description.json` and `listing/manifest.template.json`. The description contains the specific claims buyers will evaluate; the manifest describes how to run the environment. Optional holdout tasks go in `audit-tasks/` and are excluded from the buyer's download.

Check the folder and package it locally first:

```bash
./sell.sh /path/to/my-environment --dry-run
```

Then create a seller wallet and list the environment:

```bash
./sell.sh /path/to/my-environment --new-wallet --price 100 --collateral 100
```

The script saves the new wallet's private key as `SELLER_PK` in the repository's `.env`; back it up, since this wallet receives your proceeds. To use an existing wallet, set `SELLER_PK` in `.env` and omit `--new-wallet`.

The script installs its dependencies, tops up the wallet through the test faucet, packages and encrypts the environment, uploads it to the TEE for validation, creates the on-chain listing, deposits collateral, and requests the signed preview. Once the report is attached, it prints the listing URL. If a step fails, rerun the command without `--new-wallet` to resume completed steps. Keep enough unreserved collateral available for additional purchases.

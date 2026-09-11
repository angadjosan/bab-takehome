# RL Environment Market

https://rl-env-market.vercel.app

A market for reinforcement-learning environments: task sets, tools and hidden graders that AI labs use to train agents. The product can't be shown before sale. If the seller shows the tasks and tests, the buyer already has them. Sellers are environment builders. Buyers are labs and agent teams running coding RL, often through their own buyer agents. Before paying, a buyer sees a preview signed inside a TEE: how a fixed panel of reference models scores on the sealed environment, plus a screened validator note. After payment enters escrow, the buyer gets the whole environment. The buyer then has a bonded challenge window to claim specific broken or misdescribed tasks. The seller is paid only after that window closes.

## How it works

![Components](docs/diagrams/components.png)

1. **List.** The seller agent packages the environment as a canonical tar. It commits the bundle hash, a salted Merkle root over the purchased tasks and a separate root over the audit tasks, then uploads everything encrypted to the TEE. The TEE rechecks every commitment and runs a sandboxed preflight. The seller then calls `createListing` with the hashes, price and collateral.
2. **Preview.** The TEE quotes the inference cost and the seller pays it on-chain (`requestPreview`). The TEE runs one pass@1 episode per model per task through the open-source harness in an offline sandbox. Hidden tests are graded in a separate process. It signs the report (EIP-712) and attaches its hash on-chain, which releases the fee.
3. **Buy.** The buyer checks the report signature, runner role, attestation and description hash in the browser, then calls `buy`. That escrows the price and reserves the seller's collateral for this sale.
4. **Deliver.** The TEE's relay sees `Purchased` and wraps the bundle key to the buyer's X25519 key with HPKE (RFC 9180). It signs a delivery receipt and records it on-chain. The buyer decrypts in the browser and checks the plaintext against `bundleHash`.
5. **Challenge.** Before the challenge deadline, the buyer can claim specific tasks on one of three grounds. *Broken / hash mismatch* and *preview not reproducible* go to the TEE's mechanical verifier, which reruns and signs findings. *False description* goes to three staked AI jurors: they are drawn on-chain, read a case packet from the TEE, and vote by commit-reveal.
6. **Settle and rate.** Upheld claims refund the claimed tasks' share of the price once per task, up to 50%, and slash seller collateral. With no dispute, anyone can call `finalize`. Everything pays out through `withdraw()`. Buyers rate settled purchases, and seller reputation is money-weighted.

![Purchase states](docs/diagrams/purchase-states.png)

The full design is in [docs/RL_ENV_MARKET.md](docs/RL_ENV_MARKET.md), with the dispute diagram at [docs/diagrams/dispute.png](docs/diagrams/dispute.png). The interface contract is [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md).

## Trust assumptions and failure modes

The problem: a buyer can't judge an RL environment without having it, and a seller can't show it without giving it away. So the market doesn't try to prove quality up front. It gives buyers a few cheap checks before they pay and a way to get money back after.

What's in place:
- When the seller lists, the bundle hash and Merkle roots over the tasks go on-chain. After delivery, the buyer hashes what they got and compares.
- The TEE runs every task against three open models (GLM 5.3, Kimi K3, Qwen 3.8) and signs the scores, so every buyer sees the same baseline. Next step: let buyers bring their own weights and run inference on those.
- Payment sits in escrow for the dispute window. The seller is paid only after it closes.
- Seller ratings are weighted by money and only count as a score after 100 settled sales (`QUALIFYING_TX_THRESHOLD` in the contract). Until then the app shows "new seller".

What can go wrong:
- The bundle doesn't match its hash, or the key doesn't open it. Dispute it as broken. The TEE reruns and signs the finding.
- The preview scores don't reproduce. Dispute it. Same mechanical check.
- It's junk that got past the validator, or the description lies. Dispute the specific false claim. Three staked jurors vote.
- The buyer keeps a copy and claims everything is broken. Refunds are per task and capped at 50%, and the buyer posts a bond they lose if the claim fails.
- Nobody disputes before the deadline. The seller gets paid. "It didn't help my model" isn't a ground.

What you still have to trust:
- The TEE: Intel TDX on Phala Cloud, plus Phala's key service. I can push a new image to the same app. The attestation shows the change, but the contract doesn't block it.
- The jurors. Right now they're an approved panel of three that I run. The plan is open validators who stake to join.
- The owner key. It sets roles and approves jurors, but it can't touch escrow or balances.
- The inference provider (Fireworks), which sees task text during previews.

## Biggest design decision: deliver everything after escrow, then make lying expensive

The buyer can't judge an RL environment without its tasks and grader, and seeing them is having them. So the market does not try to prove quality before sale. It hands over the complete product (source, every purchased task, hidden tests, reference solutions) as soon as payment is escrowed. Protection comes after delivery instead.

I rejected three alternatives:
- **Samples or sandboxed inspection.** With 5–50 tasks per environment, a sample is a large share of the product. A buyer who can run tests in a sandbox can extract them.
- **Keeping the environment in the seller's TEE.** RL training means thousands of rollouts inside the buyer's own training loop (prime-rl, GRPO), close to their GPUs. Running training inside someone else's enclave isn't practical, and GPU TEE coverage for these models isn't available.
- **Holding payment until the buyer approves.** Then the buyer never approves.

What makes after-the-fact protection work:
- **Narrow, checkable claims.** Only three grounds qualify: broken or hash mismatch, a specific false claim in the frozen description, or a preview that doesn't reproduce. Poor training results don't count.
- **Per-task remedies.** Price is split evenly across tasks. A confirmed task is refunded once. Post-delivery refunds are capped at 50%, which limits "copy it, then claim everything".
- **Bonds.** The buyer posts a bond equal to the requested refund (5–50 tUSDC). A rejected bond goes to the jurors and a neutral reserve, never to the seller, so sellers gain nothing from provoking disputes.
- **Collateral per sale.** Each purchase reserves at least `caseFee + 10% of price` of the seller's stake, so one deposit can't back unlimited sales. If confirmed defects exceed 5% of tasks, an extra penalty is slashed.
- **A cheap, bounded pre-purchase signal.** A fixed panel runs a fixed open harness inside the TEE and the report is signed. The seller pays for it (about $1.50–2.13 per preview, measured in [docs/PREVIEW_COST.md](docs/PREVIEW_COST.md)), and it is cached per bundle so it can't be re-rolled.

The cost of this choice is that an honest buyer of a worthless environment recovers at most half the price. That is disclosed before purchase.

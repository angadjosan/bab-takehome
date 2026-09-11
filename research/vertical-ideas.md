# Black Box Bazaar: Vertical Selection and Build Recommendation

## 1. Idea landscape

| Vertical | One-line pitch | Real buyers | Real sellers | Uninspectable information | Best mechanism |
|---|---|---|---|---|---|
| Cybersecurity intelligence | Buy a newly observed phishing indicator or detection rule before it becomes public. | SOC teams, MSSPs, threat-intel platforms | Independent researchers, incident responders, security vendors | Whether an IOC/rule is novel, sourced, and detects a real campaign | Commitment + preview + escrow/stake + reputation |
| Scientific research | Buy a reproducible experimental protocol that achieves a claimed result. | Biotech startups, university labs, R&D teams | Academic labs, CROs, specialist researchers | The “missing steps” that make a protocol work in practice | Commitment + preview + pay-on-outcome |
| Model evaluations | Buy a hidden adversarial eval that reliably exposes a specified model failure. | AI labs, model providers, enterprise AI teams | Red-team researchers, evaluation boutiques, safety researchers | The prompt, test harness, and exact failure case before the buyer pays | Commitment + sealed test + escrow/stake |
| Sports scouting | Buy an undiscovered player report and video-backed projection before competing clubs see it. | Clubs, agencies, recruiting departments | Regional scouts, video analysts, data scouts | Whether the player insight is original and predicts future performance | Commitment + preview + reputation + pay-on-outcome |
| Governance analysis | Buy a forecast of a DAO proposal’s vote, turnout, or delegate behavior. | DAO treasuries, delegates, governance consultancies | Governance analysts, political-data researchers, forecasting agents | Whether the forecast is well-calibrated and contains a useful edge | Commitment + seller stake + pay-on-outcome |
| Alternative data | Buy a point-in-time dataset or signal before it is reconstructed or repackaged. | Quant funds, hedge funds, data buyers | Web-data collectors, satellite/commerce-data vendors | Whether the history existed then and improves a strategy | Hash/timestamp + preview + sealed evaluation |
| Patent prior art | Buy a precise prior-art package that could invalidate a patent claim. | IP litigators, patent attorneys, insurers | Patent researchers, technical librarians, domain experts | Whether the reference is relevant enough to matter legally | Commitment + escrow/stake + expert/jury resolution |
| Procurement intelligence | Buy a verified early signal that a company is about to issue an RFP or change suppliers. | B2B sales teams, suppliers, consultancies | Industry researchers, local operators, procurement specialists | Whether the lead is real, current, and non-public | Commitment + source proof + reputation |
| Commercial real estate | Buy an off-market seller lead with evidence of intent and property facts. | Brokers, developers, investment firms | Local scouts, title researchers, brokers | Whether the owner is actionable rather than a recycled lead | Commitment + preview + pay-on-outcome |
| Supply-chain disruption | Buy an early alert on a port, factory, or supplier disruption. | Importers, manufacturers, logistics teams | Local observers, freight analysts, satellite-data analysts | Whether the event is real and material before it is broadly known | Commitment + source proof + seller stake |
| Insurance fraud intelligence | Buy a lead identifying a potentially fraudulent claim with supporting evidence. | Carriers, SIU teams, TPAs | Investigators, claims analysts, data vendors | Whether evidence supports escalation without exposing it free | Commitment + preview + escrow/stake |
| Consumer-product trend signals | Buy a sourced signal that a product or ingredient is about to surge or fail. | CPG brands, retailers, investors | Analysts, creators, web-data collectors | Whether the signal is timely, non-obvious, and predictive | Commitment + preview + pay-on-outcome |
| Compliance change intelligence | Buy a concise, source-backed alert on a regulatory change affecting a narrow workflow. | Fintechs, health companies, compliance teams | Regulatory analysts, specialist law firms | Whether the interpretation is accurate and operationally important | Commitment + source proof + reputation |
| Energy-market field intelligence | Buy a field observation about generation outages, inventories, or infrastructure status. | Energy traders, utilities, commodity firms | Local researchers, satellite analysts, industry operators | Whether the observation is genuine and not stale | Commitment + source proof + pay-on-outcome |

## 2. Scores

Scores are 1–5; higher is better.

| Vertical | Demo-friendly | User-friendly | Mechanism credibility | One-day buildability | Vertical authenticity | Total |
|---|---:|---:|---:|---:|---:|---:|
| Cybersecurity intelligence | 4 | 4 | 4 | 4 | 5 | 21 |
| Scientific research | 2 | 3 | 3 | 2 | 5 | 15 |
| Model evaluations | 5 | 5 | 5 | 5 | 5 | 25 |
| Sports scouting | 2 | 5 | 2 | 4 | 5 | 18 |
| Governance analysis | 3 | 4 | 4 | 4 | 5 | 20 |
| Alternative data | 3 | 3 | 3 | 3 | 5 | 17 |
| Patent prior art | 3 | 3 | 3 | 3 | 5 | 17 |
| Procurement intelligence | 3 | 5 | 3 | 4 | 4 | 19 |
| Commercial real estate | 3 | 5 | 2 | 4 | 4 | 18 |
| Supply-chain disruption | 3 | 4 | 3 | 3 | 5 | 18 |
| Insurance fraud intelligence | 2 | 3 | 3 | 3 | 5 | 16 |
| Consumer-product trend signals | 3 | 5 | 3 | 4 | 4 | 19 |
| Compliance change intelligence | 2 | 4 | 3 | 3 | 5 | 17 |
| Energy-market field intelligence | 3 | 3 | 3 | 3 | 5 | 17 |

## 3. Recommendation: a marketplace for hidden model-evaluation failures

Build a marketplace where red-team agents sell reproducible adversarial evaluations to model teams.

This wins because the product is immediately legible: “pay for a hidden test that proves my model fails a claimed behavior.” It has genuine participants, a narrow and realistic claim, and a verification loop that can finish during a five-minute demo. Most importantly, the trust mechanism matches the claim. The marketplace does not pretend to prove that an eval is strategically valuable; it proves that the delivered test is the committed test and that it reproducibly triggers the promised measurable failure.

The core product should be called something like **Breakglass**: “Buy verified hidden evals for your model.”

### Exact transaction flow

1. **List**
   - Seller agent creates an eval package: prompt(s), a small scoring script, expected condition, target model/version, and a short redacted preview.
   - The package is encrypted off-chain.
   - Seller uploads the ciphertext to IPFS or a simple object store.
   - Seller posts on-chain:
     - ciphertext/content hash;
     - target model identifier;
     - machine-checkable claim, such as “model returns a disallowed medical instruction under this rubric”;
     - price;
     - seller stake;
     - verifier address;
     - challenge-window length.
   - The public preview shows category, severity, target model, a redacted prompt fragment, and the assertion type—not the exploit prompt.

2. **Buy**
   - Buyer agent selects an eval and deposits the price plus a small challenge bond into escrow.
   - The listing becomes locked: no second buyer can purchase the same “exclusive” eval during the demo.
   - The app tells the buyer exactly what will be verified: reproducibility against a fixed model endpoint and rubric, not usefulness for every future model.

3. **Deliver**
   - Seller agent reveals the decryption key, or posts it encrypted to the buyer’s wallet public key.
   - The buyer decrypts the package locally.
   - The UI checks the plaintext hash against the on-chain commitment. This proves the seller did not substitute a new evaluation after sale.

4. **Verify**
   - A neutral verifier service runs the submitted eval package against a fixed test target and deterministic scoring harness.
   - It posts a signed result to the contract within seconds: pass or fail, plus the result hash.
   - If the eval passes, escrowed payment becomes claimable by the seller after the short window.
   - If it fails, the contract refunds the price and slashes part of the seller stake to a neutral protocol pool. Do not send the slash directly to the buyer; that would reward manufactured disputes.

5. **Dispute**
   - The buyer may dispute only before automatic settlement, posting the challenge bond.
   - The allowed dispute is narrow: wrong committed content, unsupported target/model version, or verifier mismatch.
   - The verifier contract result settles mechanical disputes automatically.
   - A losing disputant loses its bond; a non-response defaults against that party.
   - No “I did not find this useful” refund exists. Information cannot be returned after inspection.

6. **Reputation**
   - Only settled paid transactions update reputation.
   - Show sellers’ completed evaluations, verifier-pass rate, dispute-loss rate, value sold, and stake currently posted.
   - New sellers have a small listing cap and must stake more relative to price.
   - Avoid generic five-star reviews; they are easy to sybil and say little about evaluation quality.

### What is on-chain vs. off-chain

| On-chain | Off-chain |
|---|---|
| Listing metadata, price, buyer and seller addresses | Encrypted eval package |
| Hash commitment to the package | Prompt execution against the target model |
| Escrow, buyer bond, seller stake | Scoring harness and raw output |
| Delivery-key-revealed state | Redacted preview |
| Signed verifier verdict and settlement | Agent reasoning and listing generation |
| Reputation counters from settled deals | Full eval content and sensitive artifacts |

The important boundary is deliberate: private eval content stays off-chain, while money, commitment, and settlement state are public and auditable.

### Recommended testnet and stack

Use **Base Sepolia** with Solidity, Foundry, and a small Next.js/TypeScript app using wagmi/viem.

- Base Sepolia is cheap, familiar, and explorer-friendly.
- One compact `EvalEscrow` contract is enough.
- Use IPFS through Pinata or a simple local/demo upload service for encrypted payloads.
- Encrypt with browser Web Crypto (`AES-GCM`); hash with `keccak256`.
- Use a verifier service with a dedicated signing key. For the demo, it runs a deterministic local “model endpoint” or a fixed public model API response fixture.
- Have the contract accept only signed verdicts from the verifier address.

A deterministic local target is not a cheat; it is the right demo harness. It proves that escrow settlement is autonomous and verifiable in minutes. The README should explicitly state that production would need multiple independent verifiers, model-version attestation, and stronger sandboxing.

### Autonomous agents

**Seller agent**

- Finds a model failure from a prepared red-team corpus.
- Packages the hidden prompt and evaluator.
- Generates a redacted preview and structured claim.
- Encrypts, hashes, pins, stakes, and lists.
- Watches escrow and releases the key.
- Receives payment or has stake slashed based on verifier result.

**Buyer agent**

- Searches by target model, risk class, severity, and price.
- Reads the structured claim and preview.
- Checks seller pass rate and stake-to-price ratio.
- Buys when a listing meets policy.
- Decrypts and locally confirms the hash.
- Triggers verification; disputes only on a mechanical mismatch.

These agents should be visibly useful but restrained. They automate operational work and apply explicit rules; they should not claim to independently judge whether a safety finding is strategically important.

### Five-minute demo storyboard

1. **0:00–0:30 — Problem and vertical**
   - Show a model team’s dashboard and explain: a red-team researcher cannot reveal the exploit prompt before payment.

2. **0:30–1:15 — Seller lists**
   - Seller agent creates “Hidden jailbreak eval: target demo model, high-severity policy failure.”
   - Show redacted preview, price, stake, ciphertext hash, and the Base Sepolia transaction.

3. **1:15–2:00 — Buyer evaluates and buys**
   - Buyer agent filters listings, compares seller reputation and stake, and locks payment plus its challenge bond.
   - Show escrow state on the block explorer.

4. **2:00–2:45 — Atomic delivery**
   - Seller releases the key.
   - Buyer decrypts locally; the UI shows “hash matches on-chain commitment.”

5. **2:45–3:45 — Verifiable test and successful payout**
   - Verifier runs the hidden eval against the fixed target.
   - It submits a signed PASS verdict on-chain.
   - Countdown settles; seller receives payment and reputation updates.

6. **3:45–4:35 — Failure path**
   - Use a second seeded listing whose package does not reproduce its claim.
   - Verifier submits FAIL.
   - Buyer receives price refund; seller stake is slashed; seller’s pass rate drops.

7. **4:35–5:00 — Honest limitations**
   - State that the system proves reproducibility against a declared target, not universal safety or commercial value.
   - Show contract address, deployed app URL, and explorer link.

### README requirements

- **Vertical:** a marketplace for hidden, reproducible AI red-team evaluations sold to model teams.
- **Trust assumptions:** the chain correctly escrows funds; the verifier honestly runs the declared harness; IPFS/object storage remains available; the target model/version is fixed for the test.
- **Biggest design decision:** reduce the seller’s claim to a machine-checkable assertion about reproducibility, instead of promising that the eval is generally “valuable.”
- **Important limitation:** a single verifier is a trust point, and a passing eval against one model version does not establish broad safety or business impact.
- Include the Base Sepolia contract address and direct block-explorer link.

### Biggest risk and scope cut

The biggest risk is spending too long integrating a real model API, secure encryption delivery, and a sophisticated verifier.

If time is short, cut to:
- two seeded encrypted eval packages;
- one deterministic local evaluation endpoint;
- one verifier signer;
- one purchase-and-pass flow;
- one seeded fail-and-slash flow;
- minimal reputation counters.

Do not cut the on-chain escrow, seller stake, commitment hash, and automatic verdict settlement. Those are the product.

## 4. Runner-up: cybersecurity detection-rule intelligence

Cybersecurity intelligence is the most compelling runner-up. Selling a hidden Sigma or YARA detection rule to a SOC team is authentic, valuable, and easy to explain. A verifier can run the rule against a fixed malware corpus and settle quickly.

It loses narrowly because the demo must safely handle suspicious artifacts, explain IOC novelty and rule quality, and avoid implying that matching a corpus proves operational usefulness. Model evaluations provide the same strong “hidden test, deterministic result” mechanism with a simpler, safer, more self-contained five-minute story.
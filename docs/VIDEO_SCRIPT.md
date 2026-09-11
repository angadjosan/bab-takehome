# Video script (≤ 5:00)

The recording covers the full flow on Base Sepolia against the deployed contracts and the EigenCompute TEE. It doesn't need polish. The windows are real, though (5 min challenge, up to 3 min each for commit and reveal), so two purchases are staged before recording, and cuts are fine wherever the chain is waiting.

## Before recording (not on camera)

| When | Do |
|---|---|
| T−20 min | TEE is up: `curl <TEE>/health` shows `attestation.kind = "eigencompute-tdx"`. The listing exists and its preview report is attached (`seller preview`). Juror stakes are deposited (`npm run register` per juror in `services/jurors`). |
| T−15 min | Start the jurors: `cd services/jurors && CHAIN_ID=84532 npm start`. Leave the terminal visible. Start the seller keeper: `cd agents && npx tsx src/seller/cli.ts keeper`. |
| T−10 min | **Purchase B (clean):** `cd agents && npx tsx src/buyer/cli.ts buy --version <V> --max-price 100 --as buyer2 && npx tsx src/buyer/cli.ts receive <B> --as buyer2`. B must be delivered at least 5 min before shot 10. |
| T−8 min | **Purchase A (agent buyer):** `npx tsx src/buyer/cli.ts buy --version <V> --max-price 100` then `receive <A>`. Run `inspect <A>` once to warm the Docker image. Keep the output in case the live run is slow. |
| T−2 min | Open tabs: app home, `/listing/<V>`, `/seller/<seller addr>`, `/activity`, basescan for EnvMarket. Terminal in `agents/`. Log out of Privy. Give a fresh Privy email wallet no funds. |

Placeholders: `<APP>` = app URL (**TBD**), `<TEE>` = TEE URL (**TBD**), `<V>` = listed version id, `<A>`/`<B>` = purchase ids, `<D>` = dispute id.

## Shot list

| # | Time | Screen / command | Say (one sentence each) |
|---|---|---|---|
| 1 | 0:00–0:20 (20 s) | `<APP>` home: the listing row with the description-hash check, "New seller — N/100 transactions" and stake. | "This market sells RL environments: training tasks with hidden graders, which can't be inspected before purchase because seeing the tests means having them." / "Everything here is live on Base Sepolia, and the token has no value." |
| 2 | 0:20–1:00 (40 s) | `/listing/<V>`: scroll the numbered claims, then the preview report (pass@1 for GLM 5.3, Kimi K3 and Qwen 3.8, purchased and audit shown separately), the validator explanation, the report hash and the EIP-712 signer with its runner role. Click the attestation link to the EigenCompute verify dashboard, then show `<TEE>/attestation` briefly. | "Before buying you get a report signed inside an Intel TDX enclave on EigenCompute: three reference models each got one attempt per task in the open-source verifiers harness, with hidden tests graded separately." / "The seller paid for this preview on-chain, and the browser checks the signature, the signer's role and the report hash against the contract." / "Inference runs on Fireworks, so Fireworks sees task text, which is disclosed here." |
| 3 | 1:00–1:30 (30 s) | Log in with Privy by email. The embedded wallet is created. Click the faucet banner, then **Buy** (approve + buy). Show the tx toast and the Purchased event. | "A buyer logs in with an email; Privy creates a wallet, the faucet gives test USDC, and buying escrows the price and reserves the seller's collateral for this sale." |
| 4 | 1:30–1:55 (25 s) | `/purchase/<new id>`: the timeline flips to Delivered with the relay receipt tx. Click download and decrypt; the bundle hash matches in green. Show the challenge deadline. | "The TEE saw the purchase, wrapped the bundle key to this browser's own encryption key with HPKE, and recorded a signed receipt; the browser decrypts and checks the result against the committed hash." / "Now the buyer has everything, including source, tests and solutions, and five minutes to challenge." |
| 5 | 1:55–2:30 (35 s) | Terminal: `npx tsx src/buyer/cli.ts inspect <A>`. Output ends `contradicted claims: C10` (T2 has 5 hidden tests; the claim says ≥ 8). | "This is an autonomous buyer agent with its own purchase: it runs the delivered environment offline in Docker and checks every claim of the frozen description." / "Claim C10 says every task has at least 8 hidden tests, and task 2 has 5." |
| 6 | 2:30–2:50 (20 s) | `npx tsx src/buyer/cli.ts dispute <A> --auto`: ground FalseDescription, taskMask `0x2`, requested 20 tUSDC, bond 20 tUSDC, evidence hash. Open the dispute tx on basescan. | "The agent files a false-description claim on exactly that task; it can win at most that task's share of the price, and it posts a bond equal to the refund it asks for." |
| 7 | 2:50–3:40 (50 s) | `/dispute/<D>`: the jury draw (selection block, seed, 3 seats). Cut to the juror terminal: case packet fetched, verdict, `commitVote`. Back to the page: 3 commitments, then reveals, then the published rationales with hashes checked. Click **Tally** if no keeper has done it. | "Three staked AI jurors are drawn from on-chain randomness; each fetches a case packet from the TEE by signing a challenge, and votes with commit-reveal so none can copy another." / "The majority earns the case fee, and a juror in the minority or one who doesn't reveal loses part of their stake." |
| 8 | 3:40–4:00 (20 s) | `/purchase/<A>` settlement panel: refund 20, bond 20 returned, seller proceeds 78.4, penalty 10 and case fee 6 from collateral. Click **Withdraw** in the claimable banner. | "The claim is upheld: the buyer gets one task's price back plus the bond, the seller keeps the rest minus the fee, and collateral pays the case fee and a penalty because defects exceeded 5% of tasks." |
| 9 | 4:00–4:20 (20 s) | `npx tsx src/buyer/cli.ts rate <A> --stars 2 --comment "C10 false"`. Then `/seller/<addr>`: disputes opened/upheld, rating, "New seller — N/100", total/reserved/available stake. | "Ratings come only from settled purchases, and seller reputation is money-weighted and stays hidden until 100 qualifying sales; until then buyers see the count, the stake and the dispute history." |
| 10 | 4:20–4:45 (25 s) | `/purchase/<B>` (buyer2's clean purchase, challenge window over): click **Finalize** (anyone can). Open the tx on basescan: PurchaseSettled, seller credited 98. | "Purchase B had no dispute; once its window closes anyone can finalize it, and the seller is paid 98 after the 2% fee." |
| 11 | 4:45–5:00 (15 s) | README: live links block, then the EnvMarket contract on basescan. | "The biggest design choice is to deliver everything after escrow and make lying expensive, rather than trying to prove quality before sale." / "The main limitation: a reference model's pass@1 shows the environment works, not that training on it will help your model." |

Total: 5:00. If you're short on time, cut shot 9's CLI rating and show only the seller page, which saves 10 s. Shorten shot 7 by cutting straight from the commits to the tallied result.

## If something stalls

- **Jurors slow to commit** (model latency): cut. The page updates on its own. The commit window is 3 min, and reveals open as soon as all 3 seats have committed.
- **`inspect` longer than 30 s:** show the output saved at T−8.
- **Purchase B not yet finalizable:** the page shows the countdown. Record shot 10 last as a separate take.
- **No Base Sepolia ETH in the Privy wallet:** set `NEXT_PUBLIC_PRIVY_SPONSOR_GAS=1` (sponsorship must be enabled in the Privy dashboard), or send 0.001 ETH from the deployer.

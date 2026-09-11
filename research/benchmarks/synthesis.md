# Private AI Benchmarks as Uninspectable Information: A Synthesis

*Five research passes merged into one report: contamination, the real eval market, benchmark quality, private-evaluation technology, and incentives and gaming. The last section is the updated marketplace design.*

---

## 1. Why this vertical fits the brief

A **benchmark** is an exam for AI models. A **private benchmark** is one whose questions are kept secret. It is valuable because it is secret: once questions are public, they leak into the internet text models are trained on, and models start passing by memory instead of skill. This is **contamination**, and it is well documented:

- **GSM1k (Scale, 2024).** Scale wrote about 1,000 fresh math problems styled like the popular GSM8K set. Some model families scored noticeably lower on the fresh set: up to 13% in the first version of the paper, about 8% in the final version. The models that could reproduce GSM8K text word for word showed the biggest gaps.
- **Training cutoffs.** GPT-4 solved 10 of 10 easy Codeforces problems from before 2021 and 0 of 10 recent ones. On LiveCodeBench, DeepSeek-33B scored about 60% on LeetCode problems published before its training cutoff and about 0% on problems published after it.
- **Paraphrasing defeats simple checks.** A 13B model trained on *reworded* test questions reached GPT-4-level scores, and the standard exact-text checks didn't catch it.

This is Arrow's information paradox in pure form. A buyer can't look at the questions before paying, and the seller can't show them without destroying their value. A leak doesn't just give the product away; it breaks the product.

## 2. The real market

**Selling expert-written questions is already big business:**
- Surge AI earns more than $1B a year and uses about 50,000 expert contractors.
- Mercor was valued at $10B, with experts earning about $85–95 an hour.
- Humanity's Last Exam (HLE) paid $5,000 each for its top 50 questions and $500 for the next 500.
- FrontierMath reportedly paid mathematicians $300–1,000 per problem.
- Vals AI sells private legal evaluations built with Am Law 100 law firms.

**Selling trusted *scores* is smaller and more fragile.** LMArena is valued at $1.7B, with about $30M a year from paid evaluations. Its credibility has taken hits.

**Realistic buyers:**
1. **Frontier labs.** They have the most money and want exclusive rights. Exclusivity is exactly what damaged FrontierMath.
2. **Companies choosing a model** for law, finance or health work. They want "score this model on questions I never see." This is probably the stronger repeat market.
3. **Model and app vendors** who want a credible third-party score to show customers.

**Realistic sellers:** credentialed experts and small benchmark shops. The big data vendors are competitors, and they set the floor on price.

## 3. What goes wrong: the failure modes

Every well-known trust failure in AI evals comes from one pattern: **someone who funds, builds, or is owned by one lab is also grading everyone else.**

| Failure | Real example | What it means for us |
|---|---|---|
| **Wrong answer keys that look like hard questions** | An audit found about 29% of HLE's chemistry and biology answers likely wrong. HLE kept only questions that stumped models, and reviewers weren't required to verify a rationale that took more than about 5 minutes. MMLU has about 6.5% errors, and 57% in its virology section. | Paying for "models fail this" rewards broken answer keys. Difficulty must never be reported without a signal for how likely the key is wrong. |
| **Recycled or reworded public questions** | Reworded MMLU/GSM8K let a 13B model match GPT-4 | Novelty checks must catch paraphrases, not just exact text |
| **Funder owns the answer key** | OpenAI funded FrontierMath and has most of the solutions. Contributors weren't told. OpenAI claimed o3 scored 25%; Epoch's own test later found about 10%. | Funding and answer access must be public. Headline scores should come only from a holdout the funder never saw. |
| **Evaluator isn't neutral** | Meta bought 49% of Scale, and Google and other labs left | The verifier must not sell training data or be tied to a lab |
| **Publishing only the best run** | Meta tested 27 private variants on LMArena. The Llama 4 variant it entered ranked about 2nd; the model it released ranked about 32nd. | Log every scoring run, not just the best one |
| **Questions leak through scoring** | About 4.7M benchmark examples were exposed to OpenAI through ordinary API use in one year. ARC keeps a separate "semi-private" set for exactly this reason. | Scoring a closed model through its API shows the questions to that lab |
| **Canaries are ignored** | GPT-4's and Claude 3.5's base models could reproduce BIG-bench's canary ID | Canaries only work if labs choose to honour them |
| **Buyers fish for the answers** | Kaggle leaderboard "shake-ups"; research on overfitting to a reused holdout | Each score returned leaks a little of the answer key |

## 4. How to judge a benchmark without seeing it

The quality research's key finding is that **most signs of quality can be measured by a verifier and posted as numbers.** That makes a "report card" credible rather than decorative.

| Report-card line | How it's computed | Why a buyer cares |
|---|---|---|
| **Size + margin of error** | For 200 questions at about 50% accuracy, a 95% margin is about ±7 points; report the smallest score gap it can reliably detect | Tells you whether the test can actually separate two models |
| **Reference-model scores ± error bars** | Run 5–15 models, report each separately | Shows how hard it is and whether it tells models apart |
| **Difficulty & discrimination** | Item response theory (from standardized testing), giving each question a difficulty and a "tells strong from weak" score. tinyBenchmarks showed 100 well-chosen items can estimate a full MMLU score to within about 2%. | Flags useless questions (everyone right or everyone wrong) and questions weaker models beat stronger models on |
| **Key-error risk** | "Suspicious" items: every reference model agrees on one answer and the key says another. Northcutt et al. (2021) found about half of such automatic flags are real errors. | **Always shown next to difficulty,** so a broken key can't pass as a hard question |
| **Saturation** | Top reference score; % of items every model gets right | Is it already too easy? |
| **Novelty** | Exact-text + embedding similarity against public benchmarks, an LLM check for paraphrases, and a "can models already finish these questions?" memorization test | Catches recycled benchmarks |
| **Exposure** | How many scoring runs so far, and against which providers | Every run through an API wears the set out |
| **Attestation** | Target skill, author credentials, rubric, whether each answer has an explanation (the seller's claims, checked where possible) | Validity is partly judgment |

Report cards need a date, and they need re-running as new models come out, because difficulty and saturation go stale.

## 5. Scoring without anyone seeing anyone's secret

An evaluation puts the **questions**, the **model**, and the **grader** in one place, and whoever runs it sees all three. Microsoft's TRUCE paper (2024) sorts the solutions by who you trust:

| Trust… | How | Practicality |
|---|---|---|
| The model owner | Send questions to their API and rely on a promise not to train on them | Easy, but the questions leak |
| The dataset owner / verifier | Run an **open-weights** model locally | Easy and fits a demo |
| A neutral third party | Kaggle hidden test sets; ARC runs submissions offline with no internet | Standard practice; the verifier sees everything |
| Hardware (TEE) | A sealed area of the chip with signed attestation; NVIDIA H100 GPUs support this at under ~9% overhead | Production-grade, but TEE.fail (2025) extracted attestation keys using hardware under $1,000 |
| Math (MPC) | Split the computation between parties so neither sees the other's data | About 12 seconds per question on a 7B model versus 0.05 normally |
| Math (zkML) | A proof that the output came from the committed model | Far too slow for large language models, and the model owner still sees the questions |

Other patterns: **commit now, reveal later** (post a fingerprint up front and reveal a random sample afterwards); **fresh or rotating questions** (LiveBench replaces about 1/6 of its questions each month); and **decentralized scoring** (Bittensor validators write model scores on-chain, using fresh or randomly sampled data).

## 6. Incentive design: what the research says to change

The research largely supports our draft design and points to these fixes:

1. **Pay for verified correctness, not for stumping models.** The verifier re-solves a random sample of questions itself. The seller's payment is released gradually through the challenge window.
2. **Salt the fingerprints.** A plain hash of a short answer like "B" can be guessed by brute force. Commit to hash(question + answer + random salt) instead.
3. **Expect some wrong answers.** Refund each confirmed-wrong question at price ÷ N. Take the seller's deposit only when errors pass a threshold (about 5%), because some error is normal.
4. **Make disputes cost a bond.** Each dispute costs a bond equal to the per-question refund, lost if the dispute is rejected, as in UMA's system. This stops buyers disputing correct answers to claw money back.
5. **Keep disputes off the public chain.** Revealing a Merkle proof on-chain publishes the question to everyone. Show disputed questions only to the jury, and post only a hash of the verdict.
6. **Use experts, not a model panel, to judge disputes.** The questions were chosen because models get them wrong, so a model panel will tend to side with the disputer. Use models to *find evidence* in the literature, as FutureHouse did, and let an expert jury decide. Peer-prediction scoring suits cases where a minority of experts is right. Majority-vote juries like Kleros work poorly for expert questions.
7. **Give each buyer its own marked copy.** Each buyer gets a slightly reworded, watermarked copy with its own fingerprint. Recent research (STAMP, radioactive benchmark watermarking) can detect contamination even at under 0.001% of training data, so a leak can be traced to a copy. It's statistical evidence, not proof.
8. **Always keep a holdout.** Even after an exclusive sale, keep a slice the buyer never sees. Headline scores come from that slice.
9. **Make the score-only option safe.**
   - Use open-weights models run by the verifier, or a TEE.
   - Return one coarse score, never per-question results.
   - Rate-limit re-runs and log every run on-chain.
   - Treat scoring a closed-API model as a partial disclosure and price it that way.
10. **Put money and reputation on the verifier too.** Give it a stake and a reputation score based on how its report cards hold up in later disputes.
11. **Disclose relationships on-chain.** Record who funded the benchmark, who has seen the answers, and what the verifier's business ties are.

## 7. Updated marketplace design

**Setup.** A seller lists a private benchmark, for example ContractLaw-Hard-200.
- It commits to **salted per-question fingerprints** (one Merkle root on-chain).
- It stores the set **encrypted off-chain**, with an explanation for every answer.
- It posts a **deposit (stake)** and declares funding and conflicts.

**Report card.** The verifier decrypts the set privately.
- It runs reference **open-weights** models.
- It computes the report card from Section 4 and **re-solves a random sample** of questions itself.
- It signs the report card and posts its hash on-chain.
- It holds back a **holdout slice**.

**Two ways to buy:**
- **Score my model (cheap, repeatable).** The buyer names an open-weights model and pays a small fee. The verifier runs it on the holdout and posts a **coarse score + error bars** on-chain. The buyer never sees the questions. Runs are rate-limited, and every run is logged.
- **Buy exclusive rights (expensive, one-time).** Payment goes into escrow. The buyer receives a **watermarked copy with its own fingerprint**, and a **challenge window** opens.

**Disputes.** During the window the buyer disputes specific questions, posting a per-question bond.
- Disputed questions go **privately** to an expert jury, with model-assisted literature evidence.
- Each upheld dispute refunds price ÷ N from the seller's deposit.
- If errors pass about 5%, more of the seller's deposit is taken and the seller's reputation drops.
- Rejected disputes lose their bond.

**Settlement and reputation.** The seller is paid what's left.
- Reputation records how accurate the seller's report cards were, the confirmed error rate, and any leaks traced to them.
- The verifier has its own stake and track record.

## 8. What's realistic for a one-day testnet demo

| Build it | Mock it and say so in the README |
|---|---|
| Escrow + seller stake + verifier-signed report card on-chain (Base Sepolia) | TEE attestation (keep an empty `attestation` field in the schema) |
| Salted Merkle commitments; random-sample reveal | Per-buyer watermarking (show that each buyer's copy has its own fingerprint) |
| Report card from a few small open-weights or cheap models | The full IRT fit (show rough difficulty bands instead) |
| Score-only purchase with a coarse on-chain score | An expert jury (demo with a seeded dispute the seller accepts or a mock juror resolves) |
| One seeded dispute: bond → upheld → price ÷ N refund | The verifier's own stake and rotation |

**Trust assumptions to state in the README:**
- The verifier is honest and neutral; it's a trusted third party.
- Open-weights models are run faithfully.
- The expert jury is honest.
- Testnet stakes have no real value, so the deterrent isn't really being tested.

**The single most important limitation:** whoever runs the evaluation sees the questions. Only a hardware enclave (TEE) or several independent verifiers remove that, and neither is in a one-day build.

---

## Key sources

**Contamination**
- GSM1k: https://arxiv.org/abs/2405.00332
- LiveCodeBench: https://arxiv.org/abs/2403.07974
- LiveBench: https://arxiv.org/abs/2406.19314
- Rephrased-sample contamination: https://arxiv.org/abs/2311.04850
- "Leak, Cheat, Repeat": https://arxiv.org/abs/2402.03927
- BIG-bench canary: https://www.alignmentforum.org/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4

**The market**
- Scale SEAL: https://scale.com/blog/leaderboard
- HLE: https://safe.ai/blog/humanitys-last-exam
- FrontierMath/OpenAI: https://epoch.ai/latest/openai-and-frontiermath
- ARC Prize policy: https://arcprize.org/policy
- The Leaderboard Illusion: https://arxiv.org/abs/2504.20879
- Vals AI: https://www.vals.ai/benchmarks

**Quality**
- Northcutt et al. 2021: https://arxiv.org/abs/2103.14749
- MMLU-Redux: https://arxiv.org/abs/2406.04127
- FutureHouse HLE audit: https://www.futurehouse.org/research/hle-exam
- SWE-bench Verified: https://openai.com/index/introducing-swe-bench-verified/
- BetterBench: https://arxiv.org/abs/2411.12990
- tinyBenchmarks: https://arxiv.org/abs/2402.14992
- Adding error bars to evals: https://arxiv.org/abs/2411.00640

**Private-evaluation technology**
- TRUCE private benchmarking: https://arxiv.org/abs/2403.00393
- H100 confidential computing overhead: https://arxiv.org/pdf/2409.03992
- TEE.fail: https://tee.fail
- zkLLM: https://arxiv.org/abs/2404.16109
- Bittensor finetuning subnet: https://github.com/NousResearch/finetuning-subnet

**Incentives**
- Benchmark watermarking: https://arxiv.org/abs/2502.17259
- STAMP: https://arxiv.org/abs/2504.13416
- Reusable holdout: https://arxiv.org/abs/1506.02629
- Ladder leaderboard: https://arxiv.org/abs/1502.04585
- UMA oracle: https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work
- LLM self-preference bias: https://arxiv.org/abs/2404.13076

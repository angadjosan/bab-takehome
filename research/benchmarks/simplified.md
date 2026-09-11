# Private AI Benchmarks: A Simple Marketplace Plan

A benchmark is an exam for AI models. A private benchmark keeps its questions secret.

That secrecy matters. If questions become public, they can end up in training data. Then a model may pass by remembering answers, not by being capable. This is called contamination.

Research shows this happens. Models often do worse on fresh versions of old math or coding tests. Even rewording a public question can fool basic “have we seen this before?” checks.

## Who buys and sells

Sellers are expert writers and small benchmark companies. They create hard questions in areas like law, finance, health, math, or coding.

Buyers include:

- AI labs that want exclusive tests.
- Companies choosing an AI model for serious work.
- AI vendors that want an independent score to show customers.

The main product is not really the questions. It is a score people can trust.

## What can go wrong

| Problem | Real example | Lesson |
|---|---|---|
| Wrong answer keys | An audit found many likely errors in Humanity’s Last Exam science questions. MMLU also has known errors. | A question that “stumps” models may just have a bad answer key. |
| Recycled questions | Reworded public questions let a smaller model score like GPT-4. | Check for paraphrases, not just copied text. |
| The funder controls the test | OpenAI funded FrontierMath and had access to much of its solution material. | Disclose funding and answer access. Keep a secret holdout the funder never saw. |
| A biased evaluator | Meta bought a large stake in Scale; other labs left. | The scorer should not be tied to a competing lab or sell training data. |
| Cherry-picking results | Meta tested many Llama variants on LMArena and submitted a stronger one than the released model. | Record every run, not only the best run. |
| Leaks during scoring | API scoring can expose benchmark questions to the model provider. | A closed-model API run partly reveals the test. |
| Too many retries | Repeated scores let buyers slowly learn the answer key. | Limit runs and give only broad results. |

## A report card for a secret benchmark

Buyers cannot read the questions. But they can still see useful facts about the test.

| Show buyers | Why it matters |
|---|---|
| Number of questions and error range | Shows whether small score differences mean anything. |
| Scores from several reference models | Shows how hard the test is. |
| Question difficulty | Finds questions that are too easy, too hard, or inconsistent. |
| Risk that an answer key is wrong | Stops bad keys from being sold as “very hard” questions. |
| Saturation | Shows whether top models already ace it. |
| Novelty checks | Looks for copied or reworded public questions. |
| Exposure count | Shows how often the test has been used and worn down. |
| Author credentials, rubric, and explanations | Shows who made it and how answers were justified. |

Think of this like buying a sealed food product: you cannot inspect every ingredient, but you can inspect the label, safety checks, date, and maker.

The report card needs a date. A benchmark can become easier as models improve.

## How to score a model without showing the test

Someone must bring together the questions, model, and grader. Whoever runs that process can see the questions.

Options include:

- Send questions to a model API: easy, but the model company sees the questions.
- Run an open model locally: practical for a demo; the verifier sees everything.
- Use a neutral evaluator: common in contests with hidden test sets.
- Use a secure hardware enclave: stronger protection, but harder to build and not perfect.
- Use advanced cryptography: promising, but currently much too slow for large language models.

Useful safeguards:

- Commit to a fingerprint of each question before selling it.
- Keep some questions as a holdout that buyers never receive.
- Rotate in fresh questions over time.
- Give each buyer a slightly different, marked copy so leaks may be traceable.

## Rules that improve incentives

- Pay sellers for correct, verified questions, not merely for questions that confuse models.
- Use a random secret value when creating fingerprints, so short answers cannot be guessed.
- Allow for a few mistakes. Refund confirmed bad questions, but penalize a seller only after errors pass a threshold, such as 5%.
- Require a small bond to file a dispute. A rejected dispute loses its bond.
- Keep disputed questions private. Publish only the final decision, not the question.
- Let qualified human experts decide disputes. Models can help find sources, but should not be the jury.
- Give each buyer a marked copy.
- Keep a holdout even after an exclusive sale.
- For score-only purchases, give one broad score with an error range, not per-question feedback.
- Limit retries and log every run.
- Require the verifier to put up money and build a public reputation.
- Publicly disclose who funded the benchmark, who saw answers, and the verifier’s business ties.

## Updated marketplace design

### 1. Seller lists a benchmark

The seller uploads an encrypted benchmark, explanations for every answer, and a deposit.

They post a public fingerprint for every question and disclose funding or conflicts of interest.

### 2. Verifier creates the report card

A neutral verifier privately checks the benchmark.

It runs a few open models, measures difficulty and novelty, checks a random sample of answers, and keeps part of the test as a secret holdout.

It signs the report card and posts proof that the report exists.

### 3. Buyers choose one of two products

**Score my model:** The verifier runs an open model on the holdout. The buyer gets one broad score and an error range. The questions remain secret.

**Buy exclusive rights:** The buyer pays into escrow and receives a marked copy. A challenge period begins.

### 4. Disputes and settlement

A buyer can challenge a question by posting a bond.

Experts privately review disputed questions. If the seller is wrong, the buyer gets a refund for that question. If the buyer is wrong, the bond is lost.

After the challenge period, the seller receives the remaining payment. Seller and verifier reputations track errors, leaks, and past reliability.

## What to build in a one-day testnet demo

Build:

- Escrow, seller deposit, and verifier-signed report card.
- Salted question fingerprints and a random-sample reveal.
- A simple report card using a few small open models.
- Score-only purchase with a broad score.
- One pre-planned dispute that triggers a per-question refund.

Mock, and clearly label as mocked:

- Secure hardware enclaves.
- Full per-buyer watermarking.
- Advanced difficulty modeling.
- A real expert jury.
- Verifier deposits and rotation.

## Key limitation

The biggest limitation is simple: whoever runs the evaluation can see the questions.

A secure hardware enclave or several independent verifiers could reduce that risk, but neither is realistic for a one-day demo.
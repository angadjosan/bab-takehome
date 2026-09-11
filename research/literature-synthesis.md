# Buying Information You Can't Inspect: A Synthesis of the Literature

*Five research passes (economics, cryptography, escrow & disputes, reputation, real-world markets) merged into one report.*

---

## 1. The problem in one paragraph

In 1962 Kenneth Arrow pointed out a trap. You can't know what a piece of information is worth until you've seen it, and once you've seen it you have no reason to pay. Information can't be returned, and it doesn't get used up when shared. So a seller can't show the goods without giving them away, and a buyer can't judge the price without seeing the goods. This is **Arrow's information paradox**. Nothing below *solves* it. Every mechanism in the literature and in real markets **moves the trust somewhere else**:

- to a referee
- to a preview
- to a sealed test
- to money the seller puts at risk
- to payment after the facts come in

## 2. Why the problem is hard

Four results explain why "just trust the seller" fails:

- **Market for lemons (Akerlof, 1970).** If buyers can't tell good information from junk, they offer an average price. Sellers of good information are underpaid, so they leave. Average quality drops, prices drop, more good sellers leave. Left alone, the market fills with garbage.
- **Cheap talk (Crawford & Sobel, 1982).** A claim that is free to make and can't be checked carries almost no information. "My data is great" is exactly what a seller of bad data would say too.
- **Verifiable disclosure unravels (Grossman, 1981; Milgrom, 1981).** When claims *can* be checked, the best sellers prove their quality, then the next best do too, until silence itself reads as bad news. Whether claims can be checked is what decides between the lemons outcome and a healthy market.
- **Fair exchange is impossible without a referee (Pagnia & Gärtner, 1999).** Two strangers swapping digital goods can't do it fairly with no trusted third party; someone has to let go first. Blockchains help because **a smart contract can be that referee**: public, mechanical, and controlled by no one.

A useful frame from Nelson (1970) and Darby & Karni (1973) sorts goods by when you can judge them:

| Type | When can you judge quality? | Information example |
|---|---|---|
| Search good | Before buying | (Almost never true of information) |
| Experience good | After using it | A dataset you can backtest, a tip that resolves next week |
| Credence good | Maybe never | "This security audit found everything," "this strategy advice was right" |

Most information is an experience good or a credence good. Markets for **experience goods** run on reputation and repeat business. Markets for **credence goods** need warranties, independent audits, and a rule that whoever diagnoses the problem isn't also the one selling the fix.

## 3. The toolkit: seven ways to trade without inspection

### Lever 1: Commitments ("sealed envelope")
The seller publishes a **hash**, a cryptographic fingerprint, of the encrypted information before any money moves. A hash can't be reversed to get the content, but anyone can check later that the delivered content matches it. This rules out changing the content after the sale or rebuilding the history afterward (the "backfill" problem that plagues alt-data vendors), and it timestamps who had the information first. It says nothing about whether the information is *good*, only that it didn't change. It's cheap, and every design should use it.

### Lever 2: Previews, teasers, and staged reveals
Anton & Yao (1994, 2002) showed a seller can profitably reveal *part* of an idea. The revealed part can be stolen, but it is a believable signal of what's still hidden. Real-world forms include free samples, abstracts, trial periods, and "pay a bit, see a bit, pay more." A sample proves little unless you can show it existed at the time it claims to (see Lever 1).

### Lever 3: Sealed evaluation (look without seeing)
The buyer's code gets to inspect the information, but the buyer doesn't.
- **Trusted execution environments (TEEs):** a sealed area inside a processor, such as Intel SGX. The seller's data and the buyer's scoring code go in, and only a verdict comes out ("quality: 87%," "matches your query: yes"). The 2025 "NDAI Agreements" paper calls this an "ironclad NDA" for AI agents. The catch is that you now trust the chip maker, and SGX has been broken (Foreshadow 2018, SGAxe 2020).
- **Compute-to-data (Ocean Protocol):** the data never moves. The buyer pays to run an approved algorithm on it and gets back only the result.
- **Pay-per-query:** sell narrow answers, not the raw dataset.

### Lever 4: Atomic swaps and cryptographic verification
When "correct" can be written as a program, cryptography can remove trust entirely:
- **Zero-knowledge contingent payments (ZKCP; Maxwell 2011, demo 2016):** the seller proves that an encrypted file contains a valid answer and that the key has a given fingerprint, revealing nothing else. A **hash time-locked contract** then pays whoever reveals that key, so the act of claiming the money publishes the key. Payment and delivery happen in the same step. It was first shown by selling a Sudoku solution for Bitcoin.
- **FairSwap (2018) / OptiSwap (2020):** these flip the burden of proof. Payment goes through automatically unless the buyer submits a small **proof of misbehavior**, pinpointing the one part of the data that doesn't match what the seller committed to. Disputes stay small and cheap enough to check on-chain.
- **zkTLS / TLSNotary:** proves that "this data really came from that website or API" without trusting the seller. It proves where data came from, not whether it's useful.
- **Key delivery through threshold networks (Lit Protocol, Threshold/TACo):** the decryption key is released only once a group of independent nodes agrees that the on-chain payment happened, so the seller can't take the money and withhold the key.

The hard limit: these tools work for **"is valid"** and **"came from X"** claims. None of them can prove "this tip is *true* or *valuable*."

### Lever 5: Escrow, bonds, and optimistic settlement
- **Escrow with a timeout.** Money sits in a contract. If the buyer stays silent past the window, the seller is paid automatically (Escrow.com, Kleros Escrow). This stops buyers from stalling forever.
- **Seller stakes and slashing.** The seller puts money at risk that is taken away ("slashed") if the information proves false. This is Spence's (1973) *costly signal*: it only works if faking quality costs more than it earns. **Numerai** is the best live example: data scientists stake tokens on their predictions and lose part of the stake if the predictions perform badly.
- **Optimistic verification.** An answer counts as correct unless someone challenges it within a window, posting a matching bond to do so (UMA's optimistic oracle, fraud proofs in optimistic rollups). Size the bond to the damage a false claim or a delay would cause, not just the item's price (Arbitrum BoLD).

### Lever 6: Pay on outcomes
The cleanest fix is to pay only once the information proves true. The information then behaves like an experience good.
- **Bug bounties (HackerOne, Immunefi):** a neutral triage team verifies the bug first, and payout follows the severity. Immunefi freezes the project's funds during a dispute.
- **Zerodium's installment bonuses:** payments kept coming only while the exploit kept working.
- **Proper scoring rules (Brier, 1950):** pay forecasters by accuracy, in a way that rewards reporting their true belief. Publish each seller's **calibration**: when they say 70%, does it happen 70% of the time?
- **Numerai's MMC:** pay for what a prediction *adds* beyond what everyone else already knows, so repackaging common knowledge earns little.

### Lever 7: Reputation, certification, and juries
For whatever cryptography and outcomes can't settle:
- **Reputation** (Resnick & Zeckhauser's eBay study, 2002) works better than theory predicts, but it fails in four known ways:
  - **Sybil attacks:** one actor creates many fake identities.
  - **Whitewashing:** a cheater drops a damaged name and starts fresh.
  - **Inflation:** average ratings drift upward until they mean nothing.
  - **Collusion:** friends rate each other up.
- **Peer prediction and Bayesian Truth Serum (Prelec, 2004; Miller, Resnick & Zeckhauser, 2005):** these reward honest reports even when the truth never arrives, by scoring each person's report against other people's reports. They're fragile: everyone agreeing to report "good" without looking can also pay. AI agents running the same underlying model may be correlated from the start.
- **Third-party certifiers** work, but "issuer pays" corrupts them. The rated party paying the rater was central to the credit-rating failures of 2008.
- **Decentralized juries (Kleros, UMA voting):** randomly drawn jurors vote, and those who vote with the majority are rewarded, on the bet that the obvious answer is the true one. Two known failures:
  - **Bribery:** a promised bribe to vote a certain way that, in theory, never has to be paid.
  - **Whale capture:** a single large holder cast about 25% of the vote on a disputed $7M Polymarket market in 2025.
- **On-chain identity:** Ethereum Attestation Service, soulbound (non-transferable) credentials, and **ERC-8004 "Trustless Agents"**. ERC-8004 sets up identity, reputation, and validation registries for AI agents, but an early study found **59–91% of reviewers showed Sybil patterns**. Reputation that costs nothing to post means nothing.

## 4. Matching the tool to the claim

The main idea across all five reports is that **different kinds of claims need different machinery**:

| What the seller is claiming | Best mechanism |
|---|---|
| "This content won't change / I had it first" | Hash commitment + on-chain timestamp |
| "This is a valid solution / matches spec X" | ZKCP or FairSwap-style proof of misbehavior |
| "This came from a real source" | zkTLS / TLSNotary proof |
| "This will turn out true" (checkable later) | Escrow + seller stake + outcome-based payout via oracle |
| "This is useful to you" (subjective) | Sealed evaluation (TEE, compute-to-data) + preview |
| "This is good" (never checkable) | Staked reputation, peer prediction, juries as a last resort |

## 5. Lessons from real markets

- **Expert networks (GLG):** the middleman's compliance rules and records are what it's really selling. The most valuable information is often the kind that's illegal to share.
- **Alt-data vendors:** buyers rerun every backtest themselves because rebuilt history always looks better than live data. Timestamped samples fix this.
- **Threat-intel sharing (ISACs):** flat membership fees invite free riding. Reward members for the quality of what they contribute.
- **Ocean Protocol:** good privacy technology didn't bring in buyers by itself. Demand is the harder problem.
- **Numerai:** probably the strongest working design. Stake up front, pay on measured results, and reward only what's new.
- **Prediction markets:** combining bets only works with enough real trading and clear rules for deciding outcomes. Augur died from too little trading; Polymarket works but has seen wash trading.
- **x402 (Coinbase's HTTP payment protocol):** a clean way for agents to pay, but it does *nothing* about quality. Most early volume was memecoin minting and wash trading.

## 6. Recurring failure modes to design against

| Who misbehaves | How |
|---|---|
| Seller | Sells garbage; resells public information as exclusive; sells the same "exclusive" tip many times; fakes history |
| Buyer | Uses the information, then claims it was bad; files disputes to delay payment; free rides |
| Referee | Bribed or whale-captured juries; issuer-pays certifiers |
| Everyone | Sybil identities, self-dealing to inflate volume, fake reviews |

Standard countermeasures:
- Bonds on **both** sides.
- Loser pays the dispute fee.
- Default ruling against whoever doesn't show up.
- Slashed stake goes to a neutral pool or is burned, **not** to the accusing buyer. This takes away the buyer's incentive to cry foul.
- No full refunds, because information can't be returned. Offer partial refunds paid out of the seller's bond.
- Count distinct counterparties and real value moved, not transaction counts.

## 7. A reference design for agents selling uninspectable information

Putting the levers together, the pattern most of the literature points to:

1. **List:** the seller agent posts an encrypted item, a hash commitment, a structured claim (which can be checked later if possible), a preview, and a **stake** sized to the price.
2. **Buy:** the buyer agent pays into **escrow** (an x402-style payment works). The key is released atomically, either through a hash time-locked contract or a threshold network that watches the escrow.
3. **Challenge window:** payment releases automatically after the window unless the buyer disputes. To dispute, the buyer posts a bond and submits evidence: a proof of misbehavior for mechanical claims, or an oracle result for outcome claims.
4. **Resolve:** mechanical disputes are settled by the contract itself. Outcome disputes go to an optimistic oracle. Only subjective disputes go to a hardened jury (random draw, hidden votes revealed later, escalating appeals, caps on voting power).
5. **Reputation:** only paid, settled transactions produce feedback, weighted by the money at stake. Sellers carry a non-transferable track record (calibration, disputes lost). New identities start with low limits or bigger stakes. Scores are shown as percentiles and old feedback decays.

## 8. The honest bottom line

- **Cryptography** can guarantee that you got *what was promised*.
- **Outcome-based payment** can guarantee you only pay if it turned out *true*.
- **Nothing** can guarantee it was *worth it* to you without a sealed evaluation or trusting someone.

Every real system chooses which of those gaps to leave open and who pays when it's exploited.

---

## Key sources

- Arrow (1962), *Economic Welfare and the Allocation of Resources for Invention*: https://www.nber.org/system/files/chapters/c2144/c2144.pdf
- Akerlof (1970), *The Market for "Lemons"*; Spence (1973), *Job Market Signaling*; Rothschild & Stiglitz (1976)
- Nelson (1970); Darby & Karni (1973), *Free Competition and the Optimal Amount of Fraud*
- Crawford & Sobel (1982), *Strategic Information Transmission*
- Anton & Yao (1994, 2002), *The Sale of Ideas*
- Stephenson et al. (2025), *NDAI Agreements*: https://arxiv.org/abs/2502.07924
- Pagnia & Gärtner (1999), on the impossibility of fair exchange without a trusted third party
- Maxwell / Bowe ZKCP demo (2016): https://bitcoincore.org/en/2016/02/26/zero-knowledge-contingent-payments-announcement/
- Dziembowski, Eckey & Faust (2018), *FairSwap*: https://eprint.iacr.org/2018/740 ; Eckey, Faust & Schlosser (2020), *OptiSwap*: https://eprint.iacr.org/2019/1330
- TLSNotary: https://tlsnotary.org ; Lit Protocol: https://developer.litprotocol.com ; Threshold TACo: https://threshold.network/build/taco/
- UMA Optimistic Oracle: https://docs.uma.xyz ; Kleros whitepaper: https://kleros.io/assets/whitepaper.pdf ; Arbitrum BoLD: https://docs.arbitrum.io/how-arbitrum-works/bold/bold-economics-of-disputes
- Resnick & Zeckhauser (2002), eBay reputation; Douceur (2002), *The Sybil Attack*; Friedman & Resnick (2001), cheap pseudonyms
- Prelec (2004), *Bayesian Truth Serum*; Miller, Resnick & Zeckhauser (2005), *Peer Prediction*
- ERC-8004 Trustless Agents: https://eips.ethereum.org/EIPS/eip-8004 ; Ethereum Attestation Service: https://docs.attest.org
- Numerai staking: https://docs.numer.ai/numerai-tournament/staking ; Ocean compute-to-data: https://docs.oceanprotocol.com/developers/compute-to-data
- Coinbase x402: https://www.coinbase.com/developer-platform/discover/launches/x402

# How to Buy Information You Cannot Check First

## The basic problem

Arrow’s paradox is simple: you cannot know if information is worth buying until you see it. But once you see it, you may not need to pay.

It is like buying a sealed box that might contain a winning lottery ticket. The seller cannot open it to prove it is valuable without giving away the prize.

This creates a “lemons” market. If buyers cannot tell good information from junk, they pay an average price. Good sellers leave because the price is too low. Soon, mostly junk remains.

The answer is not perfect trust. It is moving trust into better places: proof, deposits, outside checks, or later results.

## Seven tools

1. **Commit first.**  
   The seller posts a hash: a unique digital fingerprint of the information. This proves the item existed and was not changed later. It does not prove the item is useful.

2. **Show a small sample.**  
   Give a preview, trial, abstract, or partial answer. This is like tasting one spoonful before buying a meal. A timestamped sample is stronger because it shows the sample was not made up afterward.

3. **Test it without handing it over.**  
   Let the buyer’s test run on the seller’s data, but reveal only the result. This is like letting someone inspect a locked suitcase with an X-ray machine. Secure computer hardware and “compute-to-data” systems can do this, but they add new trust in the hardware or system.

4. **Link payment to delivery.**  
   For claims that a computer can check, payment and delivery can happen together. Cryptography can prove that the file matches the promised answer or came from a stated source. It cannot prove that a stock tip or strategy will be valuable.

5. **Use escrow and deposits.**  
   Put payment in escrow until a deadline. Make the seller post a deposit that they lose if the claim fails. The buyer should also post a deposit to discourage fake disputes.

6. **Pay for results.**  
   When possible, pay only after the information proves correct. This is how bug bounties and prediction contests work. Reward forecasts that are accurate, and especially those that add something new.

7. **Use reputation and outside judgment carefully.**  
   Reputation, certifications, and juries help with claims that cannot be checked by software. But they can be gamed with fake accounts, fake reviews, collusion, bribery, or powerful voters taking over.

## Match the tool to the claim

| Seller’s claim | Best tool |
|---|---|
| “I had this first, and it has not changed.” | Hash + timestamp |
| “This file meets the stated rules.” | Cryptographic proof or automatic dispute check |
| “This came from this website or API.” | Source proof |
| “This will be true later.” | Escrow + seller deposit + payment based on the result |
| “This will help you.” | Private test + preview |
| “This is good, but nobody can ever prove it.” | Costly reputation, expert review, or jury |

## Common ways systems fail

- Sellers may sell junk, fake past results, or resell “exclusive” information.
- Buyers may use the information and then claim it was bad.
- Referees may be bribed or controlled by a few large players.
- Fake identities, fake trades, and fake reviews can make bad actors look trustworthy.

Useful defenses include deposits on both sides, fees for losing disputes, penalties for no-shows, and reputation based only on real paid transactions. Do not give full refunds for information: unlike a shirt, information cannot be returned once seen.

## A practical design

1. The seller posts encrypted information, a hash, a short claim, a preview, and a deposit.
2. The buyer puts payment into escrow.
3. The key is released automatically once payment is locked.
4. The buyer gets a short time to challenge the claim, with a deposit and evidence.
5. Simple factual disputes are settled automatically. Claims about future results use an outside result source. Subjective disputes go to a jury only as a last resort.
6. Reputation comes from completed paid deals, not free ratings. New sellers face lower limits or larger deposits.

## Bottom line

Cryptography can show that you received the item that was promised.

Payment based on results can make sure you pay only if a claim later proves true.

But no system can fully prove that information was worth it to you. For that, you need a private test, a useful preview, or trust in someone else.
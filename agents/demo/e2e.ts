/**
 * End-to-end demo orchestrator (the story for the video).
 *
 *   tsx demo/e2e.ts [--skip-package] [--timeout-refund]
 *
 * 1. Actors: on anvil, give gas ETH (anvil_setBalance) and mint missing TestUSDC; on any other
 *    chain only CHECK balances and print what is missing (run demo/fund.ts yourself).
 * 2. Seller packages py-repair-kit, uploads to the TEE, lists, deposits collateral, gets the
 *    signed preview attached.
 * 3. BUYER browses + verifies, buys (purchase A) within its spending limit, receives + decrypts,
 *    inspects offline, finds the false claim, opens a FalseDescription dispute with evidence.
 * 4. Jurors (services/jurors, running separately) are selected on-chain, commit, reveal; anyone
 *    tallies; partial refund settles; buyer withdraws and rates.
 * 5. BUYER2 buys (purchase B), receives, does not dispute; after the challenge window anyone
 *    finalizes (the seller's keeper); buyer2 rates.
 * 6. Optional: a purchase whose delivery cannot be made is refunded after the delivery window.
 * 7. Every tx with explorer links, reputation, and a token balance-conservation check.
 *
 * Env: LISTING_PRICE / LISTING_COLLATERAL (token units; defaults: anvil 100/100, else 0.5/0.5),
 * BUYER_BUDGET, BUYER2_BUDGET, FAST_FORWARD=1 (anvil time travel), TEE_URL, E2E_DISPUTE_TIMEOUT_SEC.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { erc20Abi, formatEther, formatUnits, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { DisputeStatus, Ground, PurchaseState, Verdict, enumName, loadAbi } from '@envmarket/shared';
import {
  ANVIL,
  TX_LOG,
  balanceOf,
  chainNow,
  fmt,
  getDispute,
  getPurchase,
  loadCtx,
  marketRead,
  marketWrite,
  send,
  signer,
  sleep,
  tokenInfo,
  waitUntilChainTime,
  type Ctx,
} from '../src/common/ctx.ts';
import { sellerVersionDir, sellerWorkspace } from '../src/common/paths.ts';
import { TeeClient } from '../src/common/tee.ts';
import { browse, buy, openDispute, parseTaskMask, printComparison, rate, receive, waitForState, withdraw, type Who } from '../src/buyer/actions.ts';
import { disputePlan, inspectPurchase } from '../src/buyer/inspect.ts';
import { depositCollateral, keeperTick, listVersion, previewAndAttach, uploadVersion } from '../src/seller/actions.ts';
import { packageEnvironment, parseDescriptionLoose } from '../src/seller/package.ts';

const args = new Set(process.argv.slice(2));
const ctx = loadCtx();
const t = await tokenInfo(ctx);
const units = (x: string) => parseUnits(x, t.decimals);
const env = ctx.cfg.env;
const onAnvil = ctx.chainId === ANVIL;

const banner = (s: string) => console.log(`\n${'━'.repeat(100)}\n▶ ${s}\n${'━'.repeat(100)}`);
const step = (s: string) => console.log(`\n── ${s}`);

// ------------------------------------------------------------------------------------ actors

const roles = ['deployer', 'seller', 'buyer', 'buyer2', 'juror1', 'juror2', 'juror3'] as const;
const addr = (r: (typeof roles)[number]): Address => {
  const a = ctx.cfg.roleAddresses[r];
  if (!a) throw new Error(`missing ${r.toUpperCase()}_PK/_ADDR`);
  return a;
};
const tee = new TeeClient();
const health = await tee.health();
const teeSigner = health.signer as Address;

const price = units(env.LISTING_PRICE ?? (onAnvil ? '100' : '0.5'));
const collateral = units(env.LISTING_COLLATERAL ?? (onAnvil ? '100' : '0.5'));
const params = await marketRead<Record<string, any>>(ctx, 'params');
const jurorStake = BigInt(params.jurorStake);
const bondCapNeed = BigInt(params.bondCap);

banner(`EnvMarket end-to-end on chain ${ctx.chainId} · market ${ctx.market} · token ${t.symbol} ${ctx.token}`);
console.log(`TEE ${tee.base}: signer ${teeSigner} · attestation ${health.attestation.kind}${health.attestation.kind === 'none-local-dev' ? ' (LOCAL DEV — no hardware attestation; operator can read plaintext)' : ''}`);
console.log(`roles on-chain: runner=${await marketRead(ctx, 'isRunner', [teeSigner])} relay=${await marketRead(ctx, 'isRelay', [teeSigner])} verifier=${await marketRead(ctx, 'isVerifier', [teeSigner])}`);
console.log(`listing terms: price ${await fmt(ctx, price)}, collateral ${await fmt(ctx, collateral)} per sale; challenge ${params.challengeWindow}s, delivery ${params.deliveryWindow}s`);

step('actors and funding');
const needs: Record<string, bigint> = {
  seller: collateral * 3n,
  buyer: price + bondCapNeed,
  buyer2: price * 2n,
  juror1: jurorStake,
  juror2: jurorStake,
  juror3: jurorStake,
  deployer: 0n,
};
const gasNeed = onAnvil ? parseEther('10') : parseEther('0.00002');
let missing = false;
for (const r of roles) {
  const a = addr(r);
  let eth = await ctx.read.publicClient.getBalance({ address: a });
  if (onAnvil && eth < gasNeed) {
    await ctx.read.publicClient.request({ method: 'anvil_setBalance' as never, params: [a, `0x${parseEther('100').toString(16)}`] as never });
    eth = await ctx.read.publicClient.getBalance({ address: a });
  }
  let bal = await balanceOf(ctx, a);
  // jurors that already deposited stake don't need it again
  const staked = r.startsWith('juror') ? (await marketRead<[boolean, bigint, bigint, bigint]>(ctx, 'jurorInfo', [a]))[1] : 0n;
  const want = r.startsWith('juror') && staked >= jurorStake ? 0n : needs[r]!;
  if (bal < want) {
    if (onAnvil) {
      await send(signer(ctx, 'deployer'), { address: ctx.token, abi: loadAbi('TestUSDC'), functionName: 'mint', args: [a, want - bal], label: `anvil.mint(${r})` });
      bal = await balanceOf(ctx, a);
    } else {
      console.log(`  MISSING: ${r} ${a} has ${await fmt(ctx, bal)}, needs ${await fmt(ctx, want)}`);
      missing = true;
    }
  }
  if (!onAnvil && eth < gasNeed) {
    console.log(`  MISSING: ${r} ${a} has ${formatEther(eth)} ETH for gas`);
    missing = true;
  }
  console.log(`  ${r.padEnd(8)} ${a}  ${(await fmt(ctx, bal)).padStart(18)}  ${formatEther(eth).slice(0, 10)} ETH${staked ? `  juror stake ${await fmt(ctx, staked)}` : ''}`);
}
if (!onAnvil) {
  const eth = await ctx.read.publicClient.getBalance({ address: teeSigner });
  console.log(`  tee      ${teeSigner}  ${formatEther(eth)} ETH (submits recordDelivery/attachReport)`);
}
if (missing) {
  console.log('\nSome actors are underfunded. On real networks this script never sends funds: run `tsx demo/fund.ts` (prints a plan; `--yes` to send) and retry.');
  process.exit(2);
}
for (const j of ['juror1', 'juror2', 'juror3'] as const) {
  const [approved, total] = await marketRead<[boolean, bigint, bigint, bigint]>(ctx, 'jurorInfo', [addr(j)]);
  if (!approved || total < jurorStake) console.log(`  WARNING: ${j} approved=${approved} stake=${await fmt(ctx, total)} — run services/jurors "register" before disputes can be staffed`);
}

// balance snapshot (tokens only move between these accounts from here on)
const tracked: Array<[string, Address]> = [...roles.map((r) => [r, addr(r)] as [string, Address]), ['tee-signer', teeSigner], ['market', ctx.market]];
const uniq = new Map<string, [string, Address]>();
for (const [n, a] of tracked) if (!uniq.has(a.toLowerCase())) uniq.set(a.toLowerCase(), [n, a]);
const accounts = [...uniq.values()];
const snapshot = async () => Object.fromEntries(await Promise.all(accounts.map(async ([n, a]) => [n, await balanceOf(ctx, a)] as const)));
const before = await snapshot();
const supplyBefore = await ctx.read.publicClient.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'totalSupply' });

// ------------------------------------------------------------------------------------ seller

banner('SELLER AGENT: package → upload to TEE → list → collateral → signed preview');
const ws = sellerWorkspace();
const envVersion = parseDescriptionLoose(fs.readFileSync(path.join(ws, 'listing', 'description.json'), 'utf8')).description.environmentVersion;
const vdir = sellerVersionDir(envVersion);
if (!args.has('--skip-package') || !fs.existsSync(path.join(vdir, 'listing-input.json'))) {
  const r = packageEnvironment({
    workspace: ws,
    outDir: vdir,
    price,
    collateral,
    decimals: t.decimals,
    currency: t.symbol,
    challengeWindowSec: Number(params.challengeWindow),
    deliveryWindowSec: Number(params.deliveryWindow),
    force: true,
  });
  console.log(`[seller] packaged ${envVersion}: bundleHash ${r.bundleHash}, taskRoot ${r.listing.versionInput.taskRoot}, ${r.listing.taskIds.length} tasks + ${r.listing.auditTaskIds.length} audit (separately encrypted)`);
}
await uploadVersion(vdir, tee);
const { versionId } = await listVersion(ctx, vdir);
await depositCollateral(ctx, collateral * 3n);
await previewAndAttach(ctx, versionId, tee, vdir);

// ------------------------------------------------------------------------------------ buyer A

banner('BUYER AGENT: browse + verify → buy (spending limit) → receive → inspect → dispute');
const rows = await browse(ctx);
await printComparison(ctx, rows);
const budgetA = units(env.BUYER_BUDGET ?? formatUnits(price + bondCapNeed, t.decimals));
const A = await buy(ctx, 'buyer', versionId, price, { budget: budgetA });
step(`purchase A = #${A.purchaseId}: waiting for the TEE relay's delivery receipt`);
await receive(ctx, 'buyer', A.purchaseId);
step('offline inspection of the delivered environment + claims audit');
const findings = await inspectPurchase(ctx, A.purchaseId);
const plan = disputePlan(findings);
let disputeId: bigint | null = null;
if (!plan) {
  console.log('[buyer] no contradicted claim found → no dispute');
} else {
  const taskIds = findings.measurements.static.taskIds;
  const mask = parseTaskMask(plan.taskIds.join(','), taskIds);
  console.log(`[buyer] claim ${plan.claim.claimId} contradicted for ${plan.taskIds.join(',')} → FalseDescription dispute, taskMask 0x${mask.toString(16)}`);
  const d = await openDispute(ctx, 'buyer', A.purchaseId, Ground.FalseDescription, mask, plan.evidence);
  disputeId = d.disputeId;
}

// ------------------------------------------------------------------------------------ jurors

if (disputeId !== null) {
  banner(`JURORS: on-chain selection → commit → reveal → tally (dispute #${disputeId})`);
  const timeout = Number(env.E2E_DISPUTE_TIMEOUT_SEC ?? 1500) * 1000;
  const t0 = Date.now();
  const anyone = signer(ctx, 'deployer'); // permissionless calls: any account may submit them
  let lastLine = '';
  for (;;) {
    const { d, seats } = await getDispute(ctx, disputeId);
    const round = d.round;
    const base = (round - 1) * 3;
    const cur = seats.slice(base, base + 3);
    const line = `status ${enumName(DisputeStatus, d.status)} round ${round} · ${cur.map((s) => (s.juror === '0x0000000000000000000000000000000000000000' ? '—' : `${s.juror.slice(0, 8)}:${s.revealed ? enumName(Verdict, s.vote) : s.commitment !== `0x${'00'.repeat(32)}` ? 'committed' : 'seated'}`)).join('  ')}`;
    if (line !== lastLine) console.log(`  ${line}`);
    lastLine = line;
    if (d.status === DisputeStatus.Resolved) break;
    const block = await ctx.read.publicClient.getBlockNumber();
    const now = await chainNow(ctx);
    try {
      if (d.status === DisputeStatus.AwaitingSelection && block > d.selectionBlock && Date.now() - t0 > 20_000) {
        await marketWrite(ctx, anyone, 'selectJurors', [disputeId], `anyone.selectJurors(#${disputeId})`);
      } else if (d.status === DisputeStatus.Voting && (cur.every((s) => s.revealed) || (d.revealDeadline > 0n && now > d.revealDeadline))) {
        await marketWrite(ctx, anyone, 'tallyDispute', [disputeId], `anyone.tallyDispute(#${disputeId})`);
      }
    } catch (e) {
      // the juror processes may have done it first
      if (!/WrongState|TooEarly|already/i.test((e as Error).message)) console.log(`  (retrying: ${(e as Error).message.split('\n')[0]!.slice(0, 160)})`);
    }
    if (Date.now() - t0 > timeout) throw new Error(`dispute #${disputeId} not resolved within ${timeout / 1000}s (are the juror processes running?)`);
    await sleep(3000);
  }
  const { d, seats } = await getDispute(ctx, disputeId);
  const pA = await getPurchase(ctx, A.purchaseId);
  console.log(`\n  verdict: ${enumName(Verdict, d.verdict)}${d.fallbackNoQuorum ? ' (FallbackNoQuorum)' : ''} · refund ${await fmt(ctx, d.refund)} · seller proceeds ${await fmt(ctx, pA.sellerProceeds)} · fee ${await fmt(ctx, pA.fee)} · penalties ${await fmt(ctx, pA.penalties)}`);
  for (const s of seats.filter((x) => x.juror !== '0x0000000000000000000000000000000000000000')) {
    console.log(`  juror ${s.juror}: ${s.revealed ? enumName(Verdict, s.vote) : 'no reveal'} · reward ${await fmt(ctx, s.reward)} · slashed ${await fmt(ctx, s.slashed)}`);
  }
  step('buyer withdraws refund + bond and rates purchase A');
  await withdraw(ctx, 'buyer');
  await rate(ctx, 'buyer', A.purchaseId, 2, 'Environment runs offline as described, but T2 has only 5 hidden tests (claim C10 promised at least 8). Partial refund received.');
} else {
  step('no dispute: purchase A settles after the challenge window');
}

// ------------------------------------------------------------------------------------ buyer B

banner('BUYER2: buy → receive → no dispute → anyone finalizes after the challenge window');
const budgetB = units(env.BUYER2_BUDGET ?? formatUnits(price, t.decimals));
const B = await buy(ctx, 'buyer2', versionId, price, { budget: budgetB });
await receive(ctx, 'buyer2', B.purchaseId);
const pB = await getPurchase(ctx, B.purchaseId);
console.log(`[buyer2] accepted delivery; challenge deadline ${new Date(Number(pB.challengeDeadline) * 1000).toISOString()}`);
await waitUntilChainTime(ctx, pB.challengeDeadline);
const pA0 = await getPurchase(ctx, A.purchaseId);
const kept = await keeperTick(ctx, {});
console.log(`[keeper] finalized [${kept.finalized.join(', ')}], withdrew ${await fmt(ctx, kept.withdrawn)}`);
if (pA0.state === PurchaseState.Delivered && !kept.finalized.includes(A.purchaseId)) console.log('  (purchase A still inside its window)');
await waitForState(ctx, B.purchaseId, [PurchaseState.Settled], 120, 'settlement');
await rate(ctx, 'buyer2', B.purchaseId, 5, 'Delivered bundle verified against the listing; runs offline; clean purchase.');
if (disputeId === null) await rate(ctx, 'buyer', A.purchaseId, 4, 'Clean purchase.');

// ------------------------------------------------------------------------------------ timeout refund (optional)

if (args.has('--timeout-refund')) {
  banner('OPTIONAL: pre-delivery timeout refund');
  // buyer2 registers an unusable (low-order) X25519 key: the relay cannot wrap a key to it,
  // so no delivery receipt is ever recorded; after the delivery window anyone applies the refund.
  const c = signer(ctx, 'buyer2');
  const lowOrder = `0x01${'00'.repeat(31)}` as Hex;
  await send(c, { address: ctx.token, abi: erc20Abi as never, functionName: 'approve', args: [ctx.market, price], label: 'buyer2.approve(price)' });
  const r = await marketWrite(ctx, c, 'buy', [versionId, lowOrder, price], `buyer2.buy(v${versionId}, unusable key)`);
  const ids = await marketRead<bigint[]>(ctx, 'listPurchaseIdsByBuyer', [c.account.address]);
  const C = ids[ids.length - 1]!;
  const pC = await getPurchase(ctx, C);
  console.log(`  purchase C = #${C} (tx ${r.hash}); delivery deadline ${new Date(Number(pC.deliveryDeadline) * 1000).toISOString()}`);
  await waitUntilChainTime(ctx, pC.deliveryDeadline);
  const pC2 = await getPurchase(ctx, C);
  if (pC2.state === PurchaseState.Funded) {
    await marketWrite(ctx, c, 'refundUndelivered', [C], `buyer2.refundUndelivered(#${C})`);
    await withdraw(ctx, 'buyer2');
  } else console.log(`  purchase C state ${enumName(PurchaseState, pC2.state)} (relay delivered anyway)`);
}

// ------------------------------------------------------------------------------------ summary

banner('REPUTATION');
const seller = addr('seller');
const [q, eligible, wsum, rret] = await marketRead<[bigint, boolean, bigint, bigint]>(ctx, 'sellerScore', [seller]);
const st = await marketRead<[bigint, bigint, bigint]>(ctx, 'sellerStake', [seller]);
const vs = await marketRead<any>(ctx, 'versionStats', [versionId]);
const ss = await marketRead<any>(ctx, 'sellerStats', [seller]);
console.log(`  ${eligible ? 'Eligible seller' : `New seller — ${q}/100 transactions`} · Seller stake: ${await fmt(ctx, st[0])} (reserved ${await fmt(ctx, st[1])}, available ${await fmt(ctx, st[2])})`);
console.log(`  version ${versionId}: ${Number(vs.ratingCount) ? `${(Number(vs.ratingSum) / Number(vs.ratingCount)).toFixed(1)}★ from ${vs.ratingCount} purchaser rating(s)` : 'No purchaser ratings yet'} · settled ${vs.settledCount} · retained ${await fmt(ctx, BigInt(vs.retainedVolume))} · disputes ${vs.disputesOpened} opened / ${vs.disputesUpheld} upheld`);
console.log(`  seller: money-weighted rating (hidden until 100 tx) ${rret > 0n ? (Number(wsum) / Number(rret)).toFixed(2) : 'n/a'} · disputes ${ss.disputesOpened}/${ss.disputesUpheld} upheld · full refunds ${ss.fullRefunds}`);

banner(`TRANSACTIONS (${TX_LOG.length})`);
for (const x of TX_LOG) console.log(`  ${x.label.padEnd(36)} ${x.url ?? x.hash}  (block ${x.block}, gas ${x.gasUsed})`);

banner('BALANCE CONSERVATION');
const after = await snapshot();
const supplyAfter = await ctx.read.publicClient.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'totalSupply' });
let sumB = 0n;
let sumA = 0n;
for (const [n] of accounts) {
  sumB += before[n]!;
  sumA += after[n]!;
  const delta = after[n]! - before[n]!;
  console.log(`  ${n.padEnd(11)} ${formatUnits(before[n]!, t.decimals).padStart(14)} → ${formatUnits(after[n]!, t.decimals).padStart(14)}   Δ ${delta >= 0n ? '+' : ''}${formatUnits(delta, t.decimals)}`);
}
console.log(`  sum        ${formatUnits(sumB, t.decimals).padStart(14)} → ${formatUnits(sumA, t.decimals).padStart(14)}   (token supply ${supplyBefore === supplyAfter ? 'unchanged' : 'CHANGED'})`);
const [esc, col, bonds, jst, tre, res, cl] = await Promise.all(
  ['totalEscrow', 'totalCollateral', 'totalBonds', 'totalJurorStake', 'treasury', 'reserve', 'totalClaimable'].map((f) => marketRead<bigint>(ctx, f)),
);
const buckets = esc! + col! + bonds! + jst! + tre! + res! + cl!;
console.log(`  market balance ${formatUnits(after.market!, t.decimals)} = escrow ${formatUnits(esc!, t.decimals)} + collateral ${formatUnits(col!, t.decimals)} + bonds ${formatUnits(bonds!, t.decimals)} + juror stake ${formatUnits(jst!, t.decimals)} + treasury ${formatUnits(tre!, t.decimals)} + reserve ${formatUnits(res!, t.decimals)} + claimable ${formatUnits(cl!, t.decimals)} = ${formatUnits(buckets, t.decimals)}`);
const ok = sumA === sumB && supplyBefore === supplyAfter && buckets === after.market;
console.log(ok ? '\n✔ conserved: every token is accounted for (gas is paid in ETH only)' : '\n✘ CONSERVATION CHECK FAILED');
process.exit(ok ? 0 : 1);

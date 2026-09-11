/** Buyer agent actions: browse/verify listings, buy within a spending limit, receive, dispute, rate, withdraw. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatUnits, type Address, type Hex } from 'viem';
import {
  Ground,
  PurchaseState,
  canonicalJson,
  enumName,
  extractTar,
  fromBase64,
  maskFromIndices,
  parseManifest,
  popcount,
  sha256Hex,
  x25519PublicKey,
  type Report,
} from '@envmarket/shared';
import {
  approveExact,
  balanceOf,
  chainNow,
  fmt,
  getPurchase,
  getVersion,
  marketRead,
  marketWrite,
  sellerStake,
  signer,
  sleep,
  tokenInfo,
  type Ctx,
  type VersionTerms,
} from '../common/ctx.ts';
import { policyFile, purchaseDir, readJson, writeJson } from '../common/paths.ts';
import { verifyReport } from '../common/report.ts';
import { TeeClient, fetchVerified } from '../common/tee.ts';
import { eventsOf } from '../seller/actions.ts';
import { SpendingPolicy } from './policy.ts';
import { verifyDelivery } from './verify.ts';

export type Who = 'buyer' | 'buyer2';
const ZERO32 = `0x${'00'.repeat(32)}`;
const log = (who: string, m: string) => console.log(`[${who}] ${m}`);

export function encKeysFor(ctx: Ctx, who: Who): { secretKey: Hex; publicKey: Hex } {
  const k = ctx.cfg.encKeys[who];
  if (!k) throw new Error(`missing ${who.toUpperCase()}_ENC_SK/_PK in .env`);
  if (x25519PublicKey(k.secretKey).toLowerCase() !== k.publicKey.toLowerCase()) throw new Error(`${who.toUpperCase()}_ENC_PK does not match _ENC_SK`);
  return k;
}

/** The TEE serving a version's public docs (derived from the on-chain uri; TEE_URL overrides). */
export function teeFor(version: VersionTerms): TeeClient {
  if (process.env.TEE_URL) return new TeeClient(process.env.TEE_URL);
  return new TeeClient(version.uri.replace(/\/blobs\/?$/, ''));
}

// ------------------------------------------------------------------------------------ browse

export interface ListingRow {
  versionId: bigint;
  version: VersionTerms;
  name: string;
  environmentVersion: string;
  description: any | null;
  manifest: any | null;
  report: Report | null;
  reportHash: Hex | null;
  attestation: { kind: string; appId: string | null; verifyUrl: string | null; signerMatches: boolean | null; quoteDigestOk: boolean | null } | null;
  seller: { address: Address; qualifyingTx: bigint; eligible: boolean; badge: string; stakeTotal: bigint; stakeAvailable: bigint; disputesOpened: bigint; disputesUpheld: bigint; fullRefunds: bigint; ratingWeighted: string | null };
  stats: { ratingAvg: number | null; ratingCount: bigint; settledCount: bigint; disputesOpened: bigint; disputesUpheld: bigint };
  checks: string[];
  errors: string[];
  purchasable: boolean;
}

export async function inspectListing(ctx: Ctx, versionId: bigint): Promise<ListingRow> {
  const version = await getVersion(ctx, versionId);
  const checks: string[] = [];
  const errors: string[] = [];
  const blob = (h: Hex) => `${version.uri.replace(/\/?$/, '/')}${h.slice(2)}`;
  let description: any = null;
  let manifest: any = null;
  try {
    description = JSON.parse(Buffer.from(await fetchVerified(blob(version.descriptionHash), version.descriptionHash)).toString('utf8'));
    checks.push('description.json hash = on-chain descriptionHash');
    if (description.environmentVersion === undefined) errors.push('description has no environmentVersion');
  } catch (e) {
    errors.push(`description: ${(e as Error).message}`);
  }
  try {
    manifest = parseManifest(Buffer.from(await fetchVerified(blob(version.manifestHash), version.manifestHash)).toString('utf8'));
    checks.push('manifest.json hash = on-chain manifestHash');
    const mismatches = (['taskRoot', 'auditRoot', 'imageDigest'] as const).filter((k) => String(manifest[k]).toLowerCase() !== version[k].toLowerCase());
    if (manifest.taskCount !== version.taskCount) mismatches.push('taskRoot');
    if (manifest.auditTaskCount !== version.auditTaskCount) mismatches.push('auditRoot');
    if (String(manifest.commercialTerms.price) !== version.price.toString()) errors.push(`manifest price ${manifest.commercialTerms.price} != on-chain price ${version.price}`);
    if (mismatches.length) errors.push(`manifest disagrees with on-chain: ${[...new Set(mismatches)].join(', ')}`);
    else checks.push('manifest taskRoot/auditRoot/imageDigest/counts = on-chain');
    if (description && manifest.environmentVersion !== description.environmentVersion) errors.push('manifest/description environmentVersion differ');
  } catch (e) {
    errors.push(`manifest: ${(e as Error).message}`);
  }
  try {
    await fetchVerified(blob(version.licenseHash), version.licenseHash);
    checks.push('license hash = on-chain licenseHash');
  } catch (e) {
    errors.push(`license: ${(e as Error).message}`);
  }

  let report: Report | null = null;
  let reportHash: Hex | null = null;
  let attestation: ListingRow['attestation'] = null;
  if (version.reportHash === ZERO32) {
    errors.push('no preview report attached on-chain (not purchasable)');
  } else {
    const tee = teeFor(version);
    try {
      let payload: { report: unknown; reportHash?: string; signature?: string };
      try {
        const r = await tee.report(versionId);
        payload = { report: r.reportJson ?? r.report, reportHash: r.reportHash, signature: r.signature ?? undefined };
      } catch {
        payload = { report: Buffer.from(await fetchVerified(blob(version.reportHash), version.reportHash)).toString('utf8') };
      }
      const vr = await verifyReport(ctx, versionId, version, payload);
      report = vr.report;
      reportHash = vr.reportHash;
      checks.push(...vr.checks);
      // who attached it, and are they still an authorized runner?
      const logs = await ctx.read.publicClient.getContractEvents({ address: ctx.market, abi: ctx.abi, eventName: 'ReportAttached', args: { versionId }, fromBlock: ctx.cfg.startBlock } as never);
      const runner = (logs[0] as any)?.args?.runner as Address | undefined;
      if (runner) {
        if (runner.toLowerCase() !== report.signer.toLowerCase()) errors.push(`ReportAttached runner ${runner} != report.signer ${report.signer}`);
        const still = await marketRead<boolean>(ctx, 'isRunner', [runner]);
        checks.push(`ReportAttached by runner ${runner} (currently authorized: ${still})`);
      }
    } catch (e) {
      errors.push(`report: ${(e as Error).message}`);
    }
    try {
      const a = await tee.attestation();
      const kind = String(a.kind ?? a.attestation?.kind ?? 'unknown');
      const token: string | null = a.token ?? null;
      attestation = {
        kind,
        appId: a.appId ?? null,
        verifyUrl: a.verifyUrl ?? null,
        signerMatches: report ? String(a.signer ?? '').toLowerCase() === report.signer.toLowerCase() : null,
        quoteDigestOk: token ? sha256Hex(token) === String(a.quoteDigest ?? '').toLowerCase() : null,
      };
      if (report && kind !== report.attestation.kind) errors.push(`TEE attestation kind ${kind} != report ${report.attestation.kind}`);
      if (attestation.signerMatches === false) errors.push('TEE /attestation signer differs from report signer');
      checks.push(`TEE /attestation: kind=${kind}${kind === 'none-local-dev' ? ' (local dev, NOT a TEE)' : ''}${attestation.appId ? ` appId=${attestation.appId}` : ''}${attestation.quoteDigestOk ? ' quoteDigest=sha256(token) ✓' : ''}`);
    } catch (e) {
      errors.push(`attestation: ${(e as Error).message}`);
    }
  }

  const sellerAddr = version.seller;
  const [qualifyingTx, eligible, weightedRatingSum, ratedRetained] = await marketRead<[bigint, boolean, bigint, bigint]>(ctx, 'sellerScore', [sellerAddr]);
  const stake = await sellerStake(ctx, sellerAddr);
  const ss = await marketRead<any>(ctx, 'sellerStats', [sellerAddr]);
  const vs = await marketRead<any>(ctx, 'versionStats', [versionId]);
  const t = await tokenInfo(ctx);
  const badge = eligible
    ? ratedRetained > 0n
      ? `Seller rating ${(Number(weightedRatingSum) / Number(ratedRetained)).toFixed(2)}★`
      : 'Eligible seller — no purchaser ratings yet'
    : `New seller — ${qualifyingTx}/100 transactions · Seller stake: ${formatUnits(stake.total, t.decimals)} ${t.symbol}`;
  const collateralOk = stake.available >= version.collateral;
  const purchasable = version.active && version.reportHash !== ZERO32 && errors.length === 0 && collateralOk;
  if (!collateralOk) errors.push(`seller available stake ${formatUnits(stake.available, t.decimals)} < collateral per sale ${formatUnits(version.collateral, t.decimals)}`);
  return {
    versionId,
    version,
    name: manifest?.environmentId ?? manifest?.name ?? description?.title ?? '?',
    environmentVersion: manifest?.environmentVersion ?? description?.environmentVersion ?? '?',
    description,
    manifest,
    report,
    reportHash,
    attestation,
    seller: {
      address: sellerAddr,
      qualifyingTx,
      eligible,
      badge,
      stakeTotal: stake.total,
      stakeAvailable: stake.available,
      disputesOpened: BigInt(ss.disputesOpened),
      disputesUpheld: BigInt(ss.disputesUpheld),
      fullRefunds: BigInt(ss.fullRefunds),
      ratingWeighted: ratedRetained > 0n ? (Number(weightedRatingSum) / Number(ratedRetained)).toFixed(2) : null,
    },
    stats: {
      ratingAvg: BigInt(vs.ratingCount) > 0n ? Number(vs.ratingSum) / Number(vs.ratingCount) : null,
      ratingCount: BigInt(vs.ratingCount),
      settledCount: BigInt(vs.settledCount),
      disputesOpened: BigInt(vs.disputesOpened),
      disputesUpheld: BigInt(vs.disputesUpheld),
    },
    checks,
    errors,
    purchasable,
  };
}

export async function browse(ctx: Ctx, opts: { versionIds?: bigint[]; includeInactive?: boolean } = {}): Promise<ListingRow[]> {
  const next = await marketRead<bigint>(ctx, 'nextVersionId');
  const ids = opts.versionIds ?? Array.from({ length: Number(next - 1n) }, (_, i) => BigInt(i + 1));
  const rows: ListingRow[] = [];
  for (const id of ids) {
    const v = await getVersion(ctx, id);
    if (!v.active && !opts.includeInactive) continue;
    rows.push(await inspectListing(ctx, id));
  }
  return rows;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export async function printComparison(ctx: Ctx, rows: ListingRow[]): Promise<void> {
  const t = await tokenInfo(ctx);
  const models = [...new Set(rows.flatMap((r) => (r.report?.models ?? []).map((m) => m.requested)))];
  const head = ['ver', 'environment', 'price', 'tasks', ...models.map((m) => `${m} p@1`), 'seller', 'stake avail', 'disputes', 'rating', 'verified'];
  const widths = [4, 22, 12, 7, ...models.map(() => 16), 44, 13, 9, 14, 9];
  console.log(head.map((h, i) => pad(h, widths[i]!)).join(' │ '));
  console.log(widths.map((w) => '─'.repeat(w)).join('─┼─'));
  for (const r of rows) {
    const cells = [
      String(r.versionId),
      r.environmentVersion,
      `${formatUnits(r.version.price, t.decimals)} ${t.symbol}`,
      `${r.version.taskCount}+${r.version.auditTaskCount}a`,
      ...models.map((name) => {
        const m = r.report?.models.find((x) => x.requested === name);
        if (!m) return '—';
        if (m.status !== 'run') return 'not run';
        return `${m.purchased.pass1Rounded ?? '–'}% / a ${m.audit.pass1Rounded ?? '–'}%`;
      }),
      r.seller.badge,
      `${formatUnits(r.seller.stakeAvailable, t.decimals)}`,
      `${r.stats.disputesOpened}/${r.stats.disputesUpheld} up`,
      r.stats.ratingAvg === null ? 'no ratings yet' : `${r.stats.ratingAvg.toFixed(1)}★ (${r.stats.ratingCount})`,
      r.errors.length === 0 ? 'yes' : `NO (${r.errors.length})`,
    ];
    console.log(cells.map((c, i) => pad(c, widths[i]!)).join(' │ '));
  }
  for (const r of rows) {
    console.log(`\nversion ${r.versionId} (${r.environmentVersion}) — attestation ${r.attestation?.kind ?? 'n/a'}; report ${r.reportHash ?? '(none)'}`);
    if (r.report) {
      console.log(`  validator: ${r.report.validator.model} — "${r.report.validator.explanation}"`);
      console.log(`  uncertainty: ${r.report.uncertainty}`);
    }
    for (const c of r.checks) console.log(`  ✓ ${c}`);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
  }
}

// ------------------------------------------------------------------------------------ buy

export interface BuyResult {
  purchaseId: bigint;
  price: bigint;
  txHash: Hex;
}

export async function buy(ctx: Ctx, who: Who, versionId: bigint, maxPrice: bigint, opts: { budget?: bigint } = {}): Promise<BuyResult> {
  const policy = new SpendingPolicy(policyFile(who));
  if (opts.budget !== undefined) policy.setBudget(opts.budget);
  const row = await inspectListing(ctx, versionId);
  if (!row.purchasable) throw new Error(`refusing to buy version ${versionId}: ${row.errors.join('; ') || 'not purchasable'}`);
  const price = row.version.price;
  policy.authorize(price, { maxPrice }); // throws before any approval/tx
  const c = signer(ctx, who);
  const bal = await balanceOf(ctx, c.account.address);
  if (bal < price) throw new Error(`${who} balance ${await fmt(ctx, bal)} < price ${await fmt(ctx, price)}`);
  const enc = encKeysFor(ctx, who);
  log(who, `policy ok: price ${await fmt(ctx, price)} ≤ max ${await fmt(ctx, maxPrice)}; spent ${await fmt(ctx, policy.spent())} of budget, remaining ${await fmt(ctx, policy.remaining())}`);
  await approveExact(ctx, c, price, `${who}.approve(price)`);
  const sent = await marketWrite(ctx, c, 'buy', [versionId, enc.publicKey, maxPrice], `${who}.buy(v${versionId})`);
  const ev = eventsOf(ctx, sent.receipt, 'Purchased')[0];
  const purchaseId = BigInt(ev.purchaseId);
  policy.record({ kind: 'purchase', ref: purchaseId.toString(), amount: price, versionId: versionId.toString(), txHash: sent.hash });
  writeJson(path.join(purchaseDir(purchaseId), 'purchase.json'), {
    purchaseId,
    versionId,
    who,
    buyer: c.account.address,
    price,
    buyerEncPubKey: enc.publicKey,
    txHash: sent.hash,
    deliveryDeadline: ev.deliveryDeadline,
    listingChecks: row.checks,
  });
  log(who, `purchase #${purchaseId} funded; delivery deadline ${new Date(Number(ev.deliveryDeadline) * 1000).toISOString()}`);
  return { purchaseId, price, txHash: sent.hash };
}

// ------------------------------------------------------------------------------------ receive

export async function waitForState(ctx: Ctx, purchaseId: bigint, states: number[], timeoutSec: number, label: string): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const p = await getPurchase(ctx, purchaseId);
    if (states.includes(p.state)) return p.state;
    if (Date.now() - t0 > timeoutSec * 1000) throw new Error(`timed out waiting for purchase #${purchaseId} ${label} (state ${enumName(PurchaseState, p.state)})`);
    await sleep(1500);
  }
}

export interface Received {
  dir: string;
  bundleDir: string;
  taskIds: string[];
  checks: { name: string; detail: string }[];
}

export async function receive(ctx: Ctx, who: Who, purchaseId: bigint, opts: { timeoutSec?: number } = {}): Promise<Received> {
  const c = signer(ctx, who);
  let p = await getPurchase(ctx, purchaseId);
  if (p.state === PurchaseState.None) throw new Error(`purchase #${purchaseId} does not exist`);
  if (p.state === PurchaseState.Funded) {
    log(who, `waiting for the relay to record delivery of #${purchaseId} (deadline ${new Date(Number(p.deliveryDeadline) * 1000).toISOString()})`);
    const deadlineWait = Math.max(30, Number(p.deliveryDeadline - (await chainNow(ctx))) + 30);
    await waitForState(ctx, purchaseId, [PurchaseState.Delivered, PurchaseState.Disputed, PurchaseState.Settled, PurchaseState.Refunded], opts.timeoutSec ?? deadlineWait, 'delivery');
    p = await getPurchase(ctx, purchaseId);
  }
  if (p.state === PurchaseState.Refunded) throw new Error(`purchase #${purchaseId} was refunded (not delivered)`);
  const version = await getVersion(ctx, p.versionId);
  const relayOk = await marketRead<boolean>(ctx, 'isRelay', [p.relay]);
  if (!relayOk) throw new Error(`delivery relay ${p.relay} is not authorized on-chain`);
  const logs = await ctx.read.publicClient.getContractEvents({ address: ctx.market, abi: ctx.abi, eventName: 'Delivered', args: { purchaseId }, fromBlock: ctx.cfg.startBlock } as never);
  const ev = (logs[0] as any)?.args;
  const tee = teeFor(version);
  const d = await tee.delivery(purchaseId);
  const wrapperJson = typeof d.wrapper === 'string' ? d.wrapper : canonicalJson(d.wrapper);
  const wrappedKey = fromBase64(String(d.wrappedKey));
  const ctUrl = String(d.ciphertextUrl ?? `${version.uri.replace(/\/?$/, '/')}${version.ciphertextHash.slice(2)}`);
  const res = await fetch(ctUrl, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`fetch ciphertext ${ctUrl} → HTTP ${res.status}`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());
  const enc = encKeysFor(ctx, who);
  const out = verifyDelivery({
    chainId: ctx.chainId,
    market: ctx.market,
    purchaseId,
    buyer: c.account.address,
    buyerEncSk: enc.secretKey,
    purchase: p,
    deliveredEvent: ev ? { ciphertextHash: ev.ciphertextHash, wrappedKeyHash: ev.wrappedKeyHash, wrapperHash: ev.wrapperHash } : undefined,
    version,
    wrapperJson,
    wrappedKey,
    ciphertext,
  });
  const dir = purchaseDir(purchaseId);
  const bundleDir = path.join(dir, 'bundle');
  fs.rmSync(bundleDir, { recursive: true, force: true });
  extractTar(out.bundle, bundleDir);
  fs.writeFileSync(path.join(dir, 'wrapper.json'), wrapperJson);
  writeJson(path.join(dir, 'receipt.json'), {
    purchaseId,
    versionId: p.versionId,
    relay: p.relay,
    relayAuthorized: relayOk,
    bundleHash: version.bundleHash,
    ciphertextHash: p.ciphertextHash,
    wrappedKeyHash: p.wrappedKeyHash,
    wrapperHash: p.wrapperHash,
    challengeDeadline: p.challengeDeadline,
    taskIds: out.taskIds,
    checks: out.checks,
  });
  log(who, `delivery #${purchaseId} verified (${out.checks.length} checks) and decrypted → ${bundleDir}`);
  for (const ch of out.checks) log(who, `  ✓ ${ch.name}: ${ch.detail}`);
  return { dir, bundleDir, taskIds: out.taskIds, checks: out.checks };
}

export async function refundUndelivered(ctx: Ctx, who: Who, purchaseId: bigint): Promise<void> {
  await marketWrite(ctx, signer(ctx, who), 'refundUndelivered', [purchaseId], `${who}.refundUndelivered(#${purchaseId})`);
}

// ------------------------------------------------------------------------------------ dispute

export function parseGround(g: string): number {
  if (/^[0-9]+$/.test(g)) return Number(g);
  const k = Object.keys(Ground).find((n) => n.toLowerCase() === g.toLowerCase());
  if (!k || k === 'None') throw new Error(`unknown ground ${g} (BrokenOrHashMismatch | FalseDescription | PreviewNotReproducible)`);
  return Ground[k as keyof typeof Ground];
}

/** "T1,T3" (task ids, bit = index in manifest taskIds) or a numeric mask ("5", "0x5", "0b101"). */
export function parseTaskMask(spec: string, taskIds: string[]): bigint {
  if (/^(0x[0-9a-f]+|0b[01]+|[0-9]+)$/i.test(spec)) return BigInt(spec);
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean);
  return maskFromIndices(
    ids.map((id) => {
      const i = taskIds.indexOf(id);
      if (i < 0) throw new Error(`unknown task ${id} (tasks: ${taskIds.join(',')})`);
      return i;
    }),
  );
}

export function manifestTaskIds(purchaseId: bigint): string[] {
  const m = readJson<any>(path.join(purchaseDir(purchaseId), 'bundle', 'manifest.json'));
  return Array.isArray(m.taskIds) ? m.taskIds : [];
}

export async function openDispute(
  ctx: Ctx,
  who: Who,
  purchaseId: bigint,
  ground: number,
  taskMask: bigint,
  evidence: Uint8Array,
): Promise<{ disputeId: bigint; bond: bigint; evidenceHash: Hex }> {
  const c = signer(ctx, who);
  const p = await getPurchase(ctx, purchaseId);
  if (p.state !== PurchaseState.Delivered) throw new Error(`purchase #${purchaseId} is ${enumName(PurchaseState, p.state)}, not Delivered`);
  if ((await chainNow(ctx)) > p.challengeDeadline) throw new Error('challenge window has closed');
  const version = await getVersion(ctx, p.versionId);
  const evidenceHash = sha256Hex(evidence);
  const tee = teeFor(version);
  // Content-addressed private store: the TEE keys evidence by sha256(bytes); the on-chain
  // evidenceHash later authorizes seated jurors to receive it in their case packet.
  const up = await tee.evidenceUpload({ base64: Buffer.from(evidence).toString('base64') });
  const stored = String(up?.evidenceHash ?? up?.sha256 ?? '');
  if (`0x${stored.replace(/^0x/, '').toLowerCase()}` !== evidenceHash) throw new Error(`TEE stored evidence ${stored || '(no hash)'} != ${evidenceHash}`);
  log(who, `evidence (${evidence.length} bytes, sha256 ${evidenceHash}) uploaded privately to the TEE evidence server`);
  const [requested, bond] = await marketRead<[bigint, bigint]>(ctx, 'quoteDispute', [purchaseId, taskMask]);
  const policy = new SpendingPolicy(policyFile(who));
  policy.authorize(bond);
  log(who, `dispute quote: ${popcount(taskMask)} task(s) → requested refund ${await fmt(ctx, requested)}, bond ${await fmt(ctx, bond)}`);
  await approveExact(ctx, c, bond, `${who}.approve(bond)`);
  const sent = await marketWrite(ctx, c, 'openDispute', [purchaseId, ground, taskMask, evidenceHash], `${who}.openDispute(#${purchaseId})`);
  const ev = eventsOf(ctx, sent.receipt, 'DisputeOpened')[0];
  const disputeId = BigInt(ev.disputeId);
  policy.record({ kind: 'bond', ref: disputeId.toString(), amount: bond, txHash: sent.hash });
  writeJson(path.join(purchaseDir(purchaseId), 'dispute.json'), { disputeId, purchaseId, ground: enumName(Ground, ground), taskMask: `0x${taskMask.toString(16)}`, requested, bond, evidenceHash, txHash: sent.hash });
  log(who, `dispute #${disputeId} opened (${enumName(Ground, ground)}, mask 0x${taskMask.toString(16)})`);
  return { disputeId, bond, evidenceHash };
}

// ------------------------------------------------------------------------------------ rate / withdraw

export async function rate(ctx: Ctx, who: Who, purchaseId: bigint, stars: number, comment: string): Promise<Hex> {
  const commentHash = comment ? sha256Hex(comment) : (ZERO32 as Hex);
  if (comment) {
    try {
      const p = await getPurchase(ctx, purchaseId);
      await teeFor(await getVersion(ctx, p.versionId)).putBlob(new TextEncoder().encode(comment));
    } catch (e) {
      log(who, `note: comment not published to blob store (${(e as Error).message}); hash is still recorded on-chain`);
    }
  }
  await marketWrite(ctx, signer(ctx, who), 'rate', [purchaseId, stars, commentHash], `${who}.rate(#${purchaseId}, ${stars}★)`);
  return commentHash;
}

export async function withdraw(ctx: Ctx, who: Who | 'seller' | 'juror1' | 'juror2' | 'juror3'): Promise<bigint> {
  const c = signer(ctx, who);
  const bal = await marketRead<bigint>(ctx, 'claimable', [c.account.address]);
  if (bal === 0n) return 0n;
  await marketWrite(ctx, c, 'withdraw', [], `${who}.withdraw`);
  log(who, `withdrew ${await fmt(ctx, bal)}`);
  return bal;
}

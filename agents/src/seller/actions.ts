/** Seller agent actions: upload to the TEE, list on-chain, collateral, preview/attach, keeper. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import {
  PurchaseState,
  UPLOAD_KEYWRAP_INFO,
  encryptFile,
  randomKey,
  toBase64,
  wrapKey,
} from '@envmarket/shared';
import {
  approveExact,
  chainNow,
  fmt,
  getPurchase,
  getVersion,
  marketRead,
  marketWrite,
  sellerStake,
  signer,
  type Ctx,
} from '../common/ctx.ts';
import { readJson, writeJson } from '../common/paths.ts';
import { verifyReport } from '../common/report.ts';
import { TeeClient, fetchVerified } from '../common/tee.ts';
import { readKeys, readListingInput, readSalts, type ListingInput } from './package.ts';

export interface SellerState {
  upload?: { uploadId: string; stored: Record<string, any>; teeSigner: string; teeEncPubKey: string; at: string };
  uri?: string;
  versionId?: string;
  listingId?: string;
  listTx?: string;
  reportHash?: string;
  attachTx?: string | null;
}

export function stateFile(dir: string): string {
  return path.join(dir, 'seller-state.json');
}
export function readState(dir: string): SellerState {
  return fs.existsSync(stateFile(dir)) ? readJson<SellerState>(stateFile(dir)) : {};
}
export function writeState(dir: string, s: SellerState): void {
  writeJson(stateFile(dir), s);
}

const log = (m: string) => console.log(`[seller] ${m}`);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function eventsOf(ctx: Ctx, receipt: TransactionReceipt, eventName: string): any[] {
  return parseEventLogs({ abi: ctx.abi, logs: receipt.logs, eventName } as never).map((l: any) => l.args);
}

// ------------------------------------------------------------------------------------ upload

/**
 * Upload the encrypted bundle + audit asset to the TEE. K_bundle and K_audit are wrapped (EMKW1)
 * to the TEE's X25519 key from /health with HKDF salt = ciphertextHash and info
 * "envmarket.upload.v1"; salts travel as EMENC1 under a third fresh key K_salts, also wrapped.
 * Every digest the TEE reports back is checked against our own commitments.
 */
export async function uploadVersion(dir: string, tee = new TeeClient()): Promise<SellerState['upload']> {
  const li = readListingInput(dir);
  const v = li.versionInput;
  const keys = readKeys(dir);
  const salts = readSalts(dir);
  const health = await tee.health();
  log(`TEE ${tee.base}: signer ${health.signer}, attestation ${health.attestation.kind}, X25519 ${health.encPubKey}`);
  const encBundle = new Uint8Array(fs.readFileSync(path.join(dir, li.files.bundleCiphertext)));
  const encAudit = new Uint8Array(fs.readFileSync(path.join(dir, li.files.auditCiphertext)));
  const saltsKey = randomKey();
  const wrap = (key: Hex | Uint8Array) => toBase64(wrapKey({ key, recipientPublicKey: health.encPubKey, wrapperHash: v.ciphertextHash, info: UPLOAD_KEYWRAP_INFO }));
  const text = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const body = {
    encryptedBundle: toBase64(encBundle),
    encryptedAudit: toBase64(encAudit),
    wrappedBundleKey: wrap(keys.bundleKey),
    wrappedAuditKey: wrap(keys.auditKey),
    encryptedSalts: toBase64(encryptFile(saltsKey, new TextEncoder().encode(JSON.stringify(salts)))),
    wrappedSaltsKey: wrap(saltsKey),
    publicDocs: {
      'description.json': text(li.files.description),
      'manifest.json': text(li.files.manifest),
      ...(li.files.descriptionMd ? { 'description.md': text(li.files.descriptionMd) } : {}),
      license: { base64: toBase64(new Uint8Array(fs.readFileSync(path.join(dir, li.files.license)))) },
    },
    claims: {
      environmentVersion: li.environmentVersion,
      ciphertextHash: v.ciphertextHash,
      bundleHash: v.bundleHash,
      taskRoot: v.taskRoot,
      auditRoot: v.auditRoot,
      taskCount: v.taskCount,
      auditTaskCount: v.auditTaskCount,
      descriptionHash: v.descriptionHash,
      manifestHash: v.manifestHash,
      licenseHash: v.licenseHash,
      imageDigest: v.imageDigest,
    },
  };
  const res = await tee.sellerUpload(body);
  const stored = (res.stored ?? {}) as Record<string, any>;
  const expect: Array<[string, unknown]> = [
    ['ciphertextHash', v.ciphertextHash],
    ['bundleHash', v.bundleHash],
    ['manifestHash', v.manifestHash],
    ['descriptionHash', v.descriptionHash],
    ['licenseHash', v.licenseHash],
    ['taskRoot', v.taskRoot],
    ['auditRoot', v.auditRoot],
    ['taskCount', v.taskCount],
    ['auditTaskCount', v.auditTaskCount],
    ['imageDigest', v.imageDigest],
  ];
  for (const [k, want] of expect) {
    const got = stored[k];
    if (got === undefined) throw new Error(`TEE upload response is missing stored.${k}`);
    if (String(got).toLowerCase() !== String(want).toLowerCase()) throw new Error(`TEE stored ${k}=${got}, expected ${want}`);
  }
  const failed = (res.checks ?? []).filter((c: any) => c.ok === false);
  if (failed.length) throw new Error(`TEE upload checks failed: ${failed.map((c: any) => c.name).join(', ')}`);
  log(`upload accepted (uploadId ${res.uploadId}); TEE recomputed every commitment: ${expect.map(([k]) => k).join(', ')}`);
  if (res.preflight) log(`TEE preflight: ${JSON.stringify(res.preflight).slice(0, 300)}`);

  // Public docs are retrievable by hash from the advertised blob store (what buyers will do).
  const blobBase = String(stored.blobBaseUrl ?? tee.blobBaseUrl);
  for (const [name, h] of [
    ['description.json', v.descriptionHash],
    ['manifest.json', v.manifestHash],
    ['license', v.licenseHash],
    ['bundle ciphertext', v.ciphertextHash],
  ] as const) {
    await fetchVerified(`${blobBase.replace(/\/?$/, '/')}${h.slice(2)}`, h);
    log(`  ✓ ${name} served at ${blobBase}${h.slice(2, 14)}… and hashes to the commitment`);
  }
  const up = { uploadId: String(res.uploadId), stored, teeSigner: health.signer, teeEncPubKey: health.encPubKey, at: new Date().toISOString() };
  const st = readState(dir);
  st.upload = up;
  st.uri = blobBase;
  writeState(dir, st);
  return up;
}

// ------------------------------------------------------------------------------------ list

export async function checkTermsAgainstParams(ctx: Ctx, li: ListingInput): Promise<void> {
  const p = await marketRead<Record<string, any>>(ctx, 'params');
  const v = li.versionInput;
  const price = BigInt(v.price);
  const collateral = BigInt(v.collateral);
  if (v.challengeWindow !== 0 && v.challengeWindow < Number(p.challengeWindow)) {
    throw new Error(`challengeWindow ${v.challengeWindow}s < market minimum ${p.challengeWindow}s (repackage with --challenge-window)`);
  }
  if (v.deliveryWindow !== 0 && v.deliveryWindow > Number(p.deliveryWindow)) {
    throw new Error(`deliveryWindow ${v.deliveryWindow}s > market maximum ${p.deliveryWindow}s (repackage with --delivery-window)`);
  }
  const required = BigInt(p.caseFee) + (price * BigInt(p.penaltyBps)) / 10000n;
  if (collateral < required) throw new Error(`collateral ${collateral} < required ${required} (caseFee + penaltyBps of price)`);
}

export async function listVersion(ctx: Ctx, dir: string, opts: { uri?: string } = {}): Promise<{ versionId: bigint; listingId: bigint }> {
  const li = readListingInput(dir);
  const st = readState(dir);
  if (st.versionId) {
    log(`already listed as version ${st.versionId}`);
    return { versionId: BigInt(st.versionId), listingId: BigInt(st.listingId ?? 0) };
  }
  const uri = opts.uri ?? st.uri;
  if (!uri) throw new Error('no blob base URL: run `upload` first (or pass --uri)');
  await checkTermsAgainstParams(ctx, li);
  const v = li.versionInput;
  const input = {
    bundleHash: v.bundleHash,
    ciphertextHash: v.ciphertextHash,
    imageDigest: v.imageDigest,
    descriptionHash: v.descriptionHash,
    manifestHash: v.manifestHash,
    licenseHash: v.licenseHash,
    taskRoot: v.taskRoot,
    auditRoot: v.auditRoot,
    taskCount: v.taskCount,
    auditTaskCount: v.auditTaskCount,
    price: BigInt(v.price),
    collateral: BigInt(v.collateral),
    deliveryWindow: v.deliveryWindow,
    challengeWindow: v.challengeWindow,
    uri,
  };
  const c = signer(ctx, 'seller');
  const sent = await marketWrite(ctx, c, 'createListing', [input], 'seller.createListing');
  const created = eventsOf(ctx, sent.receipt, 'VersionCreated')[0];
  if (!created) throw new Error('no VersionCreated event');
  const versionId = BigInt(created.versionId);
  const listingId = BigInt(created.listingId);
  const onchain = await getVersion(ctx, versionId);
  for (const k of ['bundleHash', 'ciphertextHash', 'descriptionHash', 'manifestHash', 'taskRoot', 'auditRoot'] as const) {
    if (!eq(onchain[k], (v as any)[k])) throw new Error(`on-chain ${k} mismatch after listing`);
  }
  log(`listed ${li.environmentVersion} as listing ${listingId} version ${versionId} at ${await fmt(ctx, input.price)} (collateral ${await fmt(ctx, input.collateral)})`);
  writeState(dir, { ...st, uri, versionId: versionId.toString(), listingId: listingId.toString(), listTx: sent.hash });
  return { versionId, listingId };
}

// ------------------------------------------------------------------------------------ collateral

export async function depositCollateral(ctx: Ctx, amount: bigint): Promise<void> {
  const c = signer(ctx, 'seller');
  await approveExact(ctx, c, amount, 'seller.approve(collateral)');
  await marketWrite(ctx, c, 'depositCollateral', [amount], 'seller.depositCollateral');
  const s = await sellerStake(ctx, c.account.address);
  log(`seller stake: total ${await fmt(ctx, s.total)}, reserved ${await fmt(ctx, s.reserved)}, available ${await fmt(ctx, s.available)}`);
}

// ------------------------------------------------------------------------------------ preview

/**
 * Ask the TEE for the preview (runs or returns the cached report), verify hash + EIP-712 signature +
 * on-chain runner authorization + bindings, then attach it on-chain if the TEE did not.
 */
export async function previewAndAttach(ctx: Ctx, versionId: bigint, tee = new TeeClient(), dir?: string): Promise<{ reportHash: Hex; attachedBy: 'seller' | 'tee' | 'already' }> {
  log(`requesting preview for version ${versionId} (TEE runs the reference panel + validator; this can take minutes)`);
  const res = await tee.preview(versionId);
  let version = await getVersion(ctx, versionId);
  if (res.attachError) log(`TEE could not attach the report itself (${String(res.attachError).slice(0, 160)}); the seller will submit it`);
  const vr = await verifyReport(ctx, versionId, version, { report: res.reportJson ?? res.report, reportHash: res.reportHash, signature: res.signature }, { requireSignature: true });
  for (const c of vr.checks) log(`  ✓ ${c}`);
  for (const m of vr.report.models) {
    log(`  model ${m.requested} → ${m.resolved ?? '(unavailable)'} [${m.status}] purchased pass@1 ${m.purchased.pass1Rounded ?? 'n/a'}% (${m.purchased.solved}/${m.purchased.attempted}), audit ${m.audit.pass1Rounded ?? 'n/a'}%`);
  }
  let attachedBy: 'seller' | 'tee' | 'already' = 'already';
  version = await getVersion(ctx, versionId);
  if (version.reportHash === `0x${'00'.repeat(32)}`) {
    // The TEE may be submitting attachReport itself; give it a moment, then submit (anyone may).
    for (let i = 0; i < 5 && version.reportHash === `0x${'00'.repeat(32)}`; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      version = await getVersion(ctx, versionId);
    }
    if (version.reportHash === `0x${'00'.repeat(32)}`) {
      await marketWrite(ctx, signer(ctx, 'seller'), 'attachReport', [versionId, vr.reportHash, res.signature], 'seller.attachReport');
      attachedBy = 'seller';
    } else attachedBy = 'tee';
  }
  version = await getVersion(ctx, versionId);
  if (!eq(version.reportHash, vr.reportHash)) throw new Error(`on-chain reportHash ${version.reportHash} != verified ${vr.reportHash}`);
  log(`report ${vr.reportHash} attached on-chain (by ${attachedBy})`);
  if (dir) writeState(dir, { ...readState(dir), reportHash: vr.reportHash });
  return { reportHash: vr.reportHash, attachedBy };
}

// ------------------------------------------------------------------------------------ keeper

export interface KeeperResult {
  finalized: bigint[];
  refunded: bigint[];
  withdrawn: bigint;
}

/**
 * One keeper pass over the seller's purchases: finalize every Delivered purchase whose challenge
 * window has passed (permissionless), apply the timeout refund to undelivered ones (also
 * permissionless; it is the protocol rule), then withdraw the seller's pull-payment balance.
 */
export async function keeperTick(ctx: Ctx, opts: { withdraw?: boolean; who?: 'seller' } = {}): Promise<KeeperResult> {
  const c = signer(ctx, opts.who ?? 'seller');
  const me = c.account.address as Address;
  const ids = await marketRead<bigint[]>(ctx, 'listPurchaseIdsBySeller', [me]);
  const now = await chainNow(ctx);
  const out: KeeperResult = { finalized: [], refunded: [], withdrawn: 0n };
  for (const id of ids) {
    const p = await getPurchase(ctx, id);
    if (p.state === PurchaseState.Delivered && now > p.challengeDeadline) {
      await marketWrite(ctx, c, 'finalize', [id], `keeper.finalize(#${id})`);
      out.finalized.push(id);
    } else if (p.state === PurchaseState.Funded && now > p.deliveryDeadline) {
      await marketWrite(ctx, c, 'refundUndelivered', [id], `keeper.refundUndelivered(#${id})`);
      out.refunded.push(id);
    }
  }
  if (opts.withdraw !== false) {
    const bal = await marketRead<bigint>(ctx, 'claimable', [me]);
    if (bal > 0n) {
      await marketWrite(ctx, c, 'withdraw', [], 'seller.withdraw');
      out.withdrawn = bal;
      log(`withdrew ${await fmt(ctx, bal)} of proceeds`);
    }
  }
  return out;
}

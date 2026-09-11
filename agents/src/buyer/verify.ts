/**
 * Buyer-side delivery verification (pure: no network). Every check must pass before the buyer
 * trusts the plaintext; the first failure throws DeliveryVerificationError naming the check.
 */
import type { Address, Hex } from 'viem';
import {
  PurchaseState,
  decryptFile,
  fromUtf8,
  parseDeliveryWrapper,
  parseManifest,
  readTar,
  sha256Hex,
  unwrapKeyAsync,
  writeTar,
  x25519PublicKey,
  type Manifest,
  type TarEntry,
} from '@envmarket/shared';

export class DeliveryVerificationError extends Error {
  constructor(
    readonly check: string,
    detail: string,
  ) {
    super(`delivery verification failed [${check}]: ${detail}`);
  }
}

export interface Check {
  name: string;
  ok: true;
  detail: string;
}

export interface DeliveryInputs {
  chainId: number;
  market: Address;
  purchaseId: bigint;
  buyer: Address;
  buyerEncSk: Hex;
  purchase: {
    versionId: bigint;
    buyer: Address;
    state: number;
    buyerEncPubKey: Hex;
    ciphertextHash: Hex;
    wrappedKeyHash: Hex;
    wrapperHash: Hex;
    relay: Address;
  };
  /** Hashes from the on-chain Delivered event (cross-checked against storage when given). */
  deliveredEvent?: { ciphertextHash: Hex; wrappedKeyHash: Hex; wrapperHash: Hex };
  version: {
    bundleHash: Hex;
    ciphertextHash: Hex;
    manifestHash: Hex;
    imageDigest: Hex;
    taskRoot: Hex;
    auditRoot: Hex;
    taskCount: number;
    auditTaskCount: number;
  };
  wrapperJson: string;
  wrappedKey: Uint8Array;
  ciphertext: Uint8Array;
  /** Authorized relays (on-chain isRelay), checked by the caller; recorded here for the report. */
}

export interface VerifiedDelivery {
  checks: Check[];
  bundle: Uint8Array;
  entries: TarEntry[];
  manifest: Manifest;
  taskIds: string[];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Paths that must never appear in a buyer archive. */
export const FORBIDDEN_PATH_RES: RegExp[] = [
  /(^|\/)audit[-_]?tasks?(\/|$)/i,
  /(^|\/)audit(\/|$)/i,
  /(^|\/)SEEDED_DISPUTE\.md$/i,
  /(^|\/)salts?\.json$/i,
  /(^|\/)keys?\.json$/i,
  /\.(pem|key)$/i,
];
const SALT_CONTENT_RE = /"salts?"\s*:\s*[{"]/i;
const KEY_CONTENT_RE = /"(bundleKey|auditKey|K_bundle|K_audit)"\s*:/;

export async function verifyDelivery(i: DeliveryInputs): Promise<VerifiedDelivery> {
  const checks: Check[] = [];
  const must = (name: string, cond: boolean, detail: string) => {
    if (!cond) throw new DeliveryVerificationError(name, detail);
    checks.push({ name, ok: true, detail });
  };
  const p = i.purchase;

  must('purchase.state', [PurchaseState.Delivered, PurchaseState.Disputed, PurchaseState.Settled].includes(p.state as never), `on-chain state ${p.state} is a delivered state`);
  must('purchase.buyer', eq(p.buyer, i.buyer), `purchase buyer ${p.buyer} is this buyer`);
  must('buyerEncPubKey', eq(p.buyerEncPubKey, x25519PublicKey(i.buyerEncSk)), 'on-chain buyerEncPubKey matches BUYER_ENC_SK');
  if (i.deliveredEvent) {
    must(
      'delivered.event',
      eq(i.deliveredEvent.ciphertextHash, p.ciphertextHash) && eq(i.deliveredEvent.wrappedKeyHash, p.wrappedKeyHash) && eq(i.deliveredEvent.wrapperHash, p.wrapperHash),
      'Delivered event hashes equal the stored purchase record',
    );
  }
  must('ciphertextHash.version', eq(p.ciphertextHash, i.version.ciphertextHash), 'delivered ciphertextHash equals the listed version ciphertextHash');

  // Wrapper
  const wrapperHash = sha256Hex(i.wrapperJson);
  must('wrapperHash', eq(wrapperHash, p.wrapperHash), `sha256(wrapper) ${wrapperHash} == on-chain wrapperHash`);
  let w;
  try {
    w = parseDeliveryWrapper(i.wrapperJson).wrapper;
  } catch (e) {
    throw new DeliveryVerificationError('wrapper.schema', (e as Error).message);
  }
  must(
    'wrapper.binding',
    w.purchaseId === i.purchaseId.toString() &&
      w.chainId === i.chainId &&
      eq(w.market, i.market) &&
      eq(w.buyer, i.buyer) &&
      eq(w.buyerEncPubKey, p.buyerEncPubKey) &&
      w.versionId === p.versionId.toString() &&
      eq(w.bundleHash, i.version.bundleHash) &&
      eq(w.ciphertextHash, i.version.ciphertextHash) &&
      eq(w.relay, p.relay),
    'wrapper binds purchaseId, chainId, market, buyer, buyerEncPubKey, versionId, bundleHash, ciphertextHash, relay',
  );

  // Wrapped key + ciphertext
  const wkh = sha256Hex(i.wrappedKey);
  must('wrappedKeyHash', eq(wkh, p.wrappedKeyHash), `sha256(wrappedKey) ${wkh} == on-chain wrappedKeyHash`);
  const cth = sha256Hex(i.ciphertext);
  must('ciphertextHash', eq(cth, i.version.ciphertextHash), `sha256(ciphertext) ${cth} == listed ciphertextHash`);
  let key: Uint8Array;
  try {
    key = await unwrapKeyAsync({ blob: i.wrappedKey, recipientSecretKey: i.buyerEncSk, wrapperHash: p.wrapperHash });
  } catch (e) {
    throw new DeliveryVerificationError('unwrapKey', (e as Error).message);
  }
  checks.push({ name: 'unwrapKey', ok: true, detail: 'K_bundle unwrapped with BUYER_ENC_SK (HPKE, aad = wrapperHash)' });
  let bundle: Uint8Array;
  try {
    bundle = decryptFile(key, i.ciphertext);
  } catch (e) {
    throw new DeliveryVerificationError('decrypt', (e as Error).message);
  }
  checks.push({ name: 'decrypt', ok: true, detail: 'EMENC1 AES-256-GCM authenticated decryption' });
  const bh = sha256Hex(bundle);
  must('bundleHash', eq(bh, i.version.bundleHash), `sha256(canonical tar) ${bh} == on-chain bundleHash`);

  // Archive content
  let entries: TarEntry[];
  try {
    entries = readTar(bundle);
  } catch (e) {
    throw new DeliveryVerificationError('tar', (e as Error).message);
  }
  const canonical = sha256Hex(writeTar(entries.map((e) => ({ path: e.path, type: e.type, data: e.data, executable: (e.mode & 0o111) !== 0 && e.type === 'file' }))));
  must('tar.canonical', eq(canonical, bh), 'archive re-serializes to the identical canonical ustar');
  const manifestEntry = entries.find((e) => e.path === 'manifest.json' && e.type === 'file');
  must('manifest.present', !!manifestEntry, 'manifest.json present');
  const mh = sha256Hex(manifestEntry!.data);
  must('manifestHash', eq(mh, i.version.manifestHash), `sha256(manifest.json) ${mh} == on-chain manifestHash`);
  let manifest: Manifest;
  try {
    manifest = parseManifest(fromUtf8(manifestEntry!.data));
  } catch (e) {
    throw new DeliveryVerificationError('manifest.schema', (e as Error).message);
  }
  must(
    'manifest.commitments',
    eq(manifest.taskRoot, i.version.taskRoot) &&
      eq(manifest.auditRoot, i.version.auditRoot) &&
      eq(manifest.imageDigest, i.version.imageDigest) &&
      manifest.taskCount === i.version.taskCount &&
      manifest.auditTaskCount === i.version.auditTaskCount,
    'manifest taskRoot/auditRoot/imageDigest/taskCount/auditTaskCount equal the on-chain version',
  );
  const noManifest = entries.filter((e) => e.path !== 'manifest.json');
  const bd = sha256Hex(writeTar(noManifest.map((e) => ({ path: e.path, type: e.type, data: e.data, executable: (e.mode & 0o111) !== 0 && e.type === 'file' }))));
  must('manifest.bundleDigest', eq(bd, manifest.bundleDigest), `payload-without-manifest digest ${bd} == manifest.bundleDigest`);

  const graderEntries = entries.filter((e) => e.path.startsWith('grader/'));
  const gd = sha256Hex(writeTar(graderEntries.map((e) => ({ path: e.path.slice('grader/'.length), type: e.type, data: e.data, executable: (e.mode & 0o111) !== 0 && e.type === 'file' }))));
  must('grader.digest', graderEntries.length > 0 && eq(gd, String(manifest.grader.digest ?? '')), `sha256(canonical tar of grader/) ${gd} == manifest.grader.digest`);

  const taskIds = [...new Set(entries.filter((e) => /^tasks\/[^/]+\//.test(e.path) || /^tasks\/[^/]+$/.test(e.path)).map((e) => e.path.split('/')[1]!))].sort();
  must('tasks.count', taskIds.length === i.version.taskCount, `${taskIds.length} task directories == on-chain taskCount ${i.version.taskCount}`);
  for (const id of taskIds) {
    must(`tasks.${id}.task.json`, entries.some((e) => e.path === `tasks/${id}/task.json`), `tasks/${id}/task.json present`);
  }

  // Nothing that must stay with the seller / TEE
  for (const e of entries) {
    for (const re of FORBIDDEN_PATH_RES) {
      if (re.test(e.path)) throw new DeliveryVerificationError('no-private-material', `forbidden path in buyer archive: ${e.path}`);
    }
    if (e.type === 'file' && e.data.length < 2_000_000) {
      const text = Buffer.from(e.data).toString('utf8');
      if (SALT_CONTENT_RE.test(text) && /0x[0-9a-f]{64}/i.test(text)) throw new DeliveryVerificationError('no-private-material', `salt-like material in ${e.path}`);
      if (KEY_CONTENT_RE.test(text)) throw new DeliveryVerificationError('no-private-material', `key-like material in ${e.path}`);
      if (text.includes(Buffer.from(key).toString('hex'))) throw new DeliveryVerificationError('no-private-material', `bundle key bytes appear in ${e.path}`);
    }
  }
  checks.push({ name: 'no-private-material', ok: true, detail: 'no audit tasks, salts, keys or seller-private notes in the archive' });
  checks.push({
    name: 'task-leaves',
    ok: true,
    detail: 'per-task leaves are salted; buyers cannot recompute taskRoot without the seller salts (by design) — count and roots bound via manifest',
  });

  return { checks, bundle, entries, manifest, taskIds };
}

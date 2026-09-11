/**
 * Key-delivery relay.
 *
 * On `Purchased`: build the buyer-specific wrapper (canonical JSON, shared schema), wrap K_bundle
 * to the buyer's X25519 key (shared wrapKey: EMKW2 = HPKE, aad = wrapperHash; a stored ephemeral
 * key makes the blob re-derivable byte-for-byte), persist the delivery record BEFORE
 * sending anything, sign DeliveryReceipt and submit recordDelivery before the deadline. Restarts
 * are idempotent: an existing record is reused byte-for-byte, and on-chain state is checked first.
 *
 * GET /deliveries/:purchaseId serves {wrapper, wrappedKey} only once the purchase is Delivered
 * on-chain with the same wrapperHash and wrappedKeyHash.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { buildDeliveryWrapper, bytesToHex, fromBase64, KEYWRAP_INFO, KEYWRAP_MAGIC, randomBytes, sha256Hex, signDeliveryReceipt, toBase64, wrapKeyAsync } from '@envmarket/shared';
import type { Hex } from 'viem';
import { loadUpload } from './bundle.ts';
import { domainOf, requireChain, type Ctx } from './context.ts';
import { errMsg, logger } from './log.ts';
import { HttpError } from './preview.ts';

export interface DeliveryRecord {
  purchaseId: string;
  versionId: string;
  buyer: string;
  buyerEncPubKey: Hex;
  wrapperJson: string;
  wrapperHash: Hex;
  wrappedKey: string; // base64 EMKW2 (HPKE, aad = wrapperHash)
  wrappedKeyHash: Hex;
  ciphertextHash: Hex;
  bundleHash: Hex;
  ephemeralSecretKey: Hex; // private: lets the verifier re-derive the exact blob
  nonce: Hex;
  signature: Hex | null;
  tx: Hex | null;
  status: 'prepared' | 'submitted' | 'delivered' | 'failed' | 'expired';
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const PS = { None: 0, Funded: 1, Delivered: 2, Disputed: 3, Refunded: 4, Settled: 5 };

export function getDeliveryRecord(ctx: Ctx, purchaseId: bigint): DeliveryRecord | null {
  return ctx.priv.get<DeliveryRecord>('deliveries', `p${purchaseId}`);
}

function save(ctx: Ctx, r: DeliveryRecord): void {
  r.updatedAt = new Date().toISOString();
  ctx.priv.put('deliveries', `p${r.purchaseId}`, r);
}

/** Re-derive the wrapped key from the stored ephemeral key + nonce (used by the verifier). */
export function rederiveWrappedKey(rec: DeliveryRecord, bundleKey: Hex): Promise<Uint8Array> {
  return wrapKeyAsync({
    key: bundleKey,
    recipientPublicKey: rec.buyerEncPubKey,
    wrapperHash: rec.wrapperHash,
    ephemeralSecretKey: rec.ephemeralSecretKey,
    nonce: Buffer.from(rec.nonce.slice(2), 'hex'),
  });
}

export async function handlePurchased(ctx: Ctx, purchaseId: bigint): Promise<DeliveryRecord | null> {
  const chain = requireChain(ctx);
  const p = await chain.getPurchase(purchaseId);
  if (!p) return null;
  let rec = getDeliveryRecord(ctx, purchaseId);
  if (p.state !== PS.Funded) {
    if (rec && p.state !== PS.Refunded && p.wrapperHash.toLowerCase() === rec.wrapperHash && rec.status !== 'delivered') {
      rec.status = 'delivered';
      save(ctx, rec);
    }
    return rec;
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > p.deliveryDeadline) {
    logger.warn('purchase past delivery deadline; not delivering', { purchaseId });
    if (rec) (rec.status = 'expired'), save(ctx, rec);
    return rec;
  }
  const v = await chain.getVersion(p.versionId);
  if (!v) throw new Error(`version ${p.versionId} missing`);
  const up = loadUpload(ctx, v.ciphertextHash);
  if (!up) {
    logger.error('cannot deliver: no uploaded bundle key for this version', { purchaseId, versionId: p.versionId });
    return null;
  }
  if (!ctx.blobs.has(v.ciphertextHash)) {
    logger.error('cannot deliver: ciphertext blob missing', { purchaseId });
    return null;
  }
  if (!rec) {
    const built = buildDeliveryWrapper({
      purchaseId,
      chainId: chain.chainId,
      market: chain.market,
      buyer: p.buyer,
      buyerEncPubKey: p.buyerEncPubKey,
      versionId: p.versionId,
      bundleHash: v.bundleHash,
      ciphertextHash: v.ciphertextHash,
      relay: ctx.keys.account.address,
    });
    const eph = x25519.utils.randomSecretKey();
    const nonce = randomBytes(12);
    let blob: Uint8Array;
    try {
      blob = await wrapKeyAsync({ key: up.bundleKey, recipientPublicKey: p.buyerEncPubKey, wrapperHash: built.wrapperHash, ephemeralSecretKey: eph, nonce });
    } catch (e) {
      logger.error('cannot wrap key to buyerEncPubKey', { purchaseId, error: errMsg(e) });
      return null;
    }
    rec = {
      purchaseId: purchaseId.toString(),
      versionId: p.versionId.toString(),
      buyer: p.buyer.toLowerCase(),
      buyerEncPubKey: p.buyerEncPubKey.toLowerCase() as Hex,
      wrapperJson: built.json,
      wrapperHash: built.wrapperHash,
      wrappedKey: toBase64(blob),
      wrappedKeyHash: sha256Hex(blob),
      ciphertextHash: v.ciphertextHash.toLowerCase() as Hex,
      bundleHash: v.bundleHash.toLowerCase() as Hex,
      ephemeralSecretKey: bytesToHex(eph),
      nonce: bytesToHex(nonce),
      signature: null,
      tx: null,
      status: 'prepared',
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    save(ctx, rec); // persisted before any signature leaves the TEE
  }
  if (!ctx.cfg.submitTxs) return rec;
  const signature = await signDeliveryReceipt(ctx.keys.account, domainOf(ctx), {
    purchaseId,
    buyerEncPubKey: rec.buyerEncPubKey,
    ciphertextHash: rec.ciphertextHash,
    wrappedKeyHash: rec.wrappedKeyHash,
    wrapperHash: rec.wrapperHash,
  });
  rec.signature = signature;
  try {
    const { hash } = await chain.write('recordDelivery', [purchaseId, rec.ciphertextHash, rec.wrappedKeyHash, rec.wrapperHash, signature], `recordDelivery(p${purchaseId})`);
    rec.tx = hash;
    rec.status = 'delivered';
    rec.error = null;
    ctx.priv.appendLog('deliveries', { purchaseId: rec.purchaseId, tx: hash, wrapperHash: rec.wrapperHash });
  } catch (e) {
    rec.error = errMsg(e).slice(0, 500);
    rec.status = 'failed';
    save(ctx, rec);
    throw e;
  }
  save(ctx, rec);
  return rec;
}

export async function serveDelivery(ctx: Ctx, purchaseId: bigint): Promise<Record<string, unknown>> {
  const rec = getDeliveryRecord(ctx, purchaseId);
  if (!rec) throw new HttpError(404, 'no delivery prepared for this purchase');
  const chain = requireChain(ctx);
  const p = await chain.getPurchase(purchaseId);
  if (!p || ![PS.Delivered, PS.Disputed, PS.Settled].includes(p.state) || p.deliveredAt === 0n) {
    throw new HttpError(409, 'purchase is not Delivered on-chain yet');
  }
  if (p.wrapperHash.toLowerCase() !== rec.wrapperHash || p.wrappedKeyHash.toLowerCase() !== rec.wrappedKeyHash) {
    throw new HttpError(409, 'on-chain delivery record does not match this relay\'s wrapper (delivered by another relay?)');
  }
  if (sha256Hex(fromBase64(rec.wrappedKey)) !== rec.wrappedKeyHash) throw new HttpError(500, 'stored wrapped key corrupted');
  return {
    purchaseId: rec.purchaseId,
    versionId: rec.versionId,
    wrapper: rec.wrapperJson,
    wrapperParsed: JSON.parse(rec.wrapperJson),
    wrapperHash: rec.wrapperHash,
    wrappedKey: rec.wrappedKey,
    wrappedKeyHash: rec.wrappedKeyHash,
    ciphertextHash: rec.ciphertextHash,
    bundleHash: rec.bundleHash,
    ciphertextUrl: `${ctx.cfg.publicUrl}/blobs/${rec.ciphertextHash.slice(2)}`,
    relay: ctx.keys.account.address,
    deliveredTx: rec.tx,
    challengeDeadline: p.challengeDeadline.toString(),
    keywrap: { format: KEYWRAP_MAGIC, aad: 'wrapperHash', info: KEYWRAP_INFO, unwrap: 'shared unwrapKey({ blob, recipientSecretKey, wrapperHash })' },
  };
}

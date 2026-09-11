/**
 * Buyer-specific delivery wrapper (around the unchanged ciphertext).
 *
 * canonical JSON (sorted keys, no whitespace):
 * {"buyer","buyerEncPubKey","bundleHash","chainId","ciphertextHash","issuedAt","market","purchaseId","relay","type","versionId"}
 * - purchaseId / versionId: decimal strings; chainId / issuedAt (unix seconds): JSON integers;
 * - addresses and bytes32 values are lowercase 0x-hex.
 * wrapperHash = sha256(wrapperJSON bytes).
 */
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, fromUtf8, normalizeBytes32, sha256Hex } from './hash.ts';
import { zAddressLower, zBytes32, zNonNegInt, zPosInt, zUintString } from './schemas.ts';

export const DELIVERY_WRAPPER_TYPE = 'envmarket.delivery.v1';

export const deliveryWrapperSchema = z.strictObject({
  type: z.literal(DELIVERY_WRAPPER_TYPE),
  purchaseId: zUintString,
  chainId: zPosInt,
  market: zAddressLower,
  buyer: zAddressLower,
  buyerEncPubKey: zBytes32,
  versionId: zUintString,
  bundleHash: zBytes32,
  ciphertextHash: zBytes32,
  issuedAt: zNonNegInt,
  relay: zAddressLower,
});
export type DeliveryWrapper = z.infer<typeof deliveryWrapperSchema>;

export interface DeliveryWrapperInput {
  purchaseId: bigint | number | string;
  chainId: number | bigint;
  market: Address;
  buyer: Address;
  buyerEncPubKey: Hex;
  versionId: bigint | number | string;
  bundleHash: Hex;
  ciphertextHash: Hex;
  /** unix seconds; defaults to now */
  issuedAt?: number;
  relay: Address;
}

function addr(a: string, name: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new TypeError(`${name} must be an address`);
  return a.toLowerCase();
}

function uintStr(v: bigint | number | string, name: string): string {
  const b = BigInt(v);
  if (b < 0n) throw new TypeError(`${name} must be non-negative`);
  return b.toString(10);
}

export interface BuiltDeliveryWrapper {
  wrapper: DeliveryWrapper;
  json: string;
  wrapperHash: Hex;
}

/** Build the wrapper, its canonical JSON and wrapperHash. */
export function buildDeliveryWrapper(input: DeliveryWrapperInput): BuiltDeliveryWrapper {
  const wrapper = deliveryWrapperSchema.parse({
    type: DELIVERY_WRAPPER_TYPE,
    purchaseId: uintStr(input.purchaseId, 'purchaseId'),
    chainId: Number(input.chainId),
    market: addr(input.market, 'market'),
    buyer: addr(input.buyer, 'buyer'),
    buyerEncPubKey: normalizeBytes32(input.buyerEncPubKey, 'buyerEncPubKey'),
    versionId: uintStr(input.versionId, 'versionId'),
    bundleHash: normalizeBytes32(input.bundleHash, 'bundleHash'),
    ciphertextHash: normalizeBytes32(input.ciphertextHash, 'ciphertextHash'),
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
    relay: addr(input.relay, 'relay'),
  });
  const json = canonicalJson(wrapper);
  return { wrapper, json, wrapperHash: sha256Hex(json) };
}

/** wrapperHash of a wrapper object (re-canonicalized) or of exact JSON text/bytes. */
export function wrapperHashOf(w: DeliveryWrapper | string | Uint8Array): Hex {
  if (typeof w === 'string' || w instanceof Uint8Array) return sha256Hex(w);
  return sha256Hex(canonicalJson(deliveryWrapperSchema.parse(w)));
}

/** Parse wrapper JSON, requiring canonical form and a valid schema. */
export function parseDeliveryWrapper(json: string | Uint8Array): BuiltDeliveryWrapper {
  const text = typeof json === 'string' ? json : fromUtf8(json);
  const wrapper = deliveryWrapperSchema.parse(JSON.parse(text));
  if (canonicalJson(wrapper) !== text) throw new Error('delivery wrapper JSON is not canonical');
  return { wrapper, json: text, wrapperHash: sha256Hex(text) };
}

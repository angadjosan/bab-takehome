/**
 * Encryption formats.
 *
 * EMENC1 (bundle / audit asset): "EMENC1" (6) ‖ nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16); no AAD.
 *   Implemented with the platform AES-GCM (node:crypto / OpenSSL).
 *
 * EMKW2 (wrapped key): "EMKW2" (5) ‖ enc (32) ‖ HPKE ciphertext (32-byte key ‖ 16-byte tag) = 85 bytes.
 *   HPKE (RFC 9180), mode_base, single shot, suite
 *     KEM  DHKEM(X25519, HKDF-SHA256)  0x0020
 *     KDF  HKDF-SHA256                 0x0001
 *     AEAD AES-256-GCM                 0x0002
 *   info = "envmarket.keywrap.v1" (deliveries) or "envmarket.upload.v1" (seller → TEE upload);
 *   aad  = the 32 wrapperHash bytes (for uploads: the ciphertextHash), which binds the wrapped key
 *          to the buyer-specific delivery wrapper.
 *
 * X25519 keys are raw 32-byte values rendered as 0x-hex (bytes32 on-chain), which is exactly the
 * RFC 9180 SerializePublicKey/SerializePrivateKey encoding for X25519.
 *
 * Two implementations of EMKW2, byte-for-byte identical (tests pin RFC 9180 test vectors and
 * cross-check both directions, plus pyhpke when available):
 *   - `wrapKeyAsync` / `unwrapKeyAsync`: the reference path, @hpke/core + @hpke/dhkem-x25519.
 *   - `wrapKey` / `unwrapKey` (synchronous): the RFC 9180 base-mode key schedule written over audited
 *     primitives (@noble/curves X25519, @noble/hashes HKDF extract/expand, node:crypto AES-GCM). It
 *     exists only because every current caller is synchronous and @hpke/core is WebCrypto-async;
 *     delete it once callers `await` the async pair.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Hex } from 'viem';
import { bytes32ToBytes, bytesToHex, concatBytes, equalBytes, hexToBytes, sha256Hex, utf8 } from './hash.ts';

export const ENC_MAGIC = 'EMENC1';
export const KEYWRAP_MAGIC = 'EMKW2';
/** HPKE info for keys wrapped to a buyer (aad = wrapperHash). */
export const KEYWRAP_INFO = 'envmarket.keywrap.v1';
/** HPKE info for keys wrapped by the seller to the TEE service's X25519 key (upload path). */
export const UPLOAD_KEYWRAP_INFO = 'envmarket.upload.v1';

const ENC_MAGIC_BYTES = utf8(ENC_MAGIC);
const KW_MAGIC_BYTES = utf8(KEYWRAP_MAGIC);
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const ENC_LEN = 32; // X25519 Nenc
export const WRAPPED_KEY_LEN = KW_MAGIC_BYTES.length + ENC_LEN + KEY_LEN + TAG_LEN; // 85

export type KeyLike = Uint8Array | Hex;

function keyBytes(k: KeyLike, name: string): Uint8Array {
  return bytes32ToBytes(k, name);
}

/** Cryptographically secure random bytes (WebCrypto). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** Fresh random 32-byte symmetric key (K_bundle / K_audit). */
export function randomKey(): Uint8Array {
  return randomBytes(KEY_LEN);
}

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

/* ------------------------------ AES-256-GCM (platform) ------------------------------ */

function gcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  if (aad) c.setAAD(aad);
  return concatBytes(c.update(plaintext), c.final(), c.getAuthTag());
}

/** Throws on authentication failure. `sealed` = ciphertext ‖ tag. */
function gcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (sealed.length < TAG_LEN) throw new Error('truncated');
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  if (aad) d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  return concatBytes(d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final());
}

/** Encrypt into the EMENC1 file format. `nonce` is random unless given (tests only). */
export function encryptFile(key: KeyLike, plaintext: Uint8Array, nonce?: Uint8Array): Uint8Array {
  const n = nonce ?? randomBytes(NONCE_LEN);
  if (n.length !== NONCE_LEN) throw new Error('EMENC1: nonce must be 12 bytes');
  return concatBytes(ENC_MAGIC_BYTES, n, gcmSeal(keyBytes(key, 'key'), n, plaintext));
}

/** Decrypt an EMENC1 file. Throws on wrong magic, truncation, wrong key or tampering. */
export function decryptFile(key: KeyLike, blob: Uint8Array): Uint8Array {
  if (!startsWith(blob, ENC_MAGIC_BYTES)) throw new Error('EMENC1: bad magic');
  const minLen = ENC_MAGIC_BYTES.length + NONCE_LEN + TAG_LEN;
  if (blob.length < minLen) throw new Error('EMENC1: truncated');
  const n = blob.subarray(ENC_MAGIC_BYTES.length, ENC_MAGIC_BYTES.length + NONCE_LEN);
  const k = keyBytes(key, 'key');
  try {
    return gcmOpen(k, n, blob.subarray(ENC_MAGIC_BYTES.length + NONCE_LEN));
  } catch {
    throw new Error('EMENC1: authentication failed (wrong key or tampered ciphertext)');
  }
}

/* ------------------------------------ X25519 ------------------------------------ */

export interface X25519KeyPair {
  secretKey: Hex;
  publicKey: Hex;
}

/** New X25519 encryption keypair (separate from wallet keys). */
export function generateX25519KeyPair(): X25519KeyPair {
  const sk = x25519.utils.randomSecretKey();
  return { secretKey: bytesToHex(sk), publicKey: bytesToHex(x25519.getPublicKey(sk)) };
}

/** X25519 public key for a secret key. */
export function x25519PublicKey(secretKey: KeyLike): Hex {
  return bytesToHex(x25519.getPublicKey(keyBytes(secretKey, 'secretKey')));
}

/** Raw X25519 shared secret; rejects low-order (all-zero) results as RFC 9180 §7.1.4 requires. */
export function x25519SharedSecret(secretKey: KeyLike, publicKey: KeyLike): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(keyBytes(secretKey, 'secretKey'), keyBytes(publicKey, 'publicKey'));
  } catch (e) {
    throw new Error(`X25519: invalid key (${(e as Error).message})`);
  }
  if (equalBytes(shared, new Uint8Array(32))) throw new Error('X25519: low-order public key');
  return shared;
}

/* ------------------------- HPKE base mode, synchronous (RFC 9180) ------------------------- */

const HPKE_KEM_ID = 0x0020;
const HPKE_KDF_ID = 0x0001;
const HPKE_AEAD_ID = 0x0002;
const i2osp2 = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const HPKE_V1 = utf8('HPKE-v1');
const KEM_SUITE_ID = concatBytes(utf8('KEM'), i2osp2(HPKE_KEM_ID));
const HPKE_SUITE_ID = concatBytes(utf8('HPKE'), i2osp2(HPKE_KEM_ID), i2osp2(HPKE_KDF_ID), i2osp2(HPKE_AEAD_ID));
const EMPTY = new Uint8Array(0);

const labeledExtract = (suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, concatBytes(HPKE_V1, suiteId, utf8(label), ikm), salt);
const labeledExpand = (suiteId: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(sha256, prk, concatBytes(i2osp2(len), HPKE_V1, suiteId, utf8(label), info), len);

/** DHKEM ExtractAndExpand (RFC 9180 §4.1). */
function kemSharedSecret(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', concatBytes(enc, pkR), 32);
}

/** KeySchedule for mode_base (RFC 9180 §5.1). */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): { key: Uint8Array; baseNonce: Uint8Array } {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'info_hash', info);
  const ctx = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY);
  return { key: labeledExpand(HPKE_SUITE_ID, secret, 'key', ctx, KEY_LEN), baseNonce: labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', ctx, NONCE_LEN) };
}

export interface HpkeSealArgs {
  recipientPublicKey: KeyLike;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  /** Fixed ephemeral secret key (deterministic re-derivation / tests); random otherwise. */
  ephemeralSecretKey?: KeyLike;
}

/** HPKE SealBase single shot (first message, seq 0). Returns { enc, ct } with ct = ciphertext ‖ tag. */
export function hpkeSealBase(a: HpkeSealArgs): { enc: Uint8Array; ct: Uint8Array } {
  const pkR = keyBytes(a.recipientPublicKey, 'recipientPublicKey');
  const skE = a.ephemeralSecretKey ? keyBytes(a.ephemeralSecretKey, 'ephemeralSecretKey') : x25519.utils.randomSecretKey();
  const enc = x25519.getPublicKey(skE);
  const dh = x25519SharedSecret(skE, pkR);
  const { key, baseNonce } = keySchedule(kemSharedSecret(dh, enc, pkR), a.info);
  return { enc, ct: gcmSeal(key, baseNonce, a.plaintext, a.aad) };
}

/** HPKE OpenBase single shot. Throws on any authentication failure. */
export function hpkeOpenBase(a: { recipientSecretKey: KeyLike; enc: Uint8Array; info: Uint8Array; aad: Uint8Array; ct: Uint8Array }): Uint8Array {
  const skR = keyBytes(a.recipientSecretKey, 'recipientSecretKey');
  const dh = x25519SharedSecret(skR, a.enc);
  const { key, baseNonce } = keySchedule(kemSharedSecret(dh, a.enc, x25519.getPublicKey(skR)), a.info);
  return gcmOpen(key, baseNonce, a.ct, a.aad);
}

/* ---------------------------------- EMKW2 key wrap ---------------------------------- */

export interface WrapKeyArgs {
  /** The 32-byte symmetric key to wrap (e.g. K_bundle). */
  key: KeyLike;
  /** Recipient X25519 public key (buyerEncPubKey). */
  recipientPublicKey: KeyLike;
  /** HPKE aad; for deliveries this is the wrapperHash (for uploads, the ciphertextHash). */
  wrapperHash: KeyLike;
  /** HPKE info; default "envmarket.keywrap.v1". */
  info?: string;
  /** Deterministic ephemeral key (re-derivation / tests); random otherwise. */
  ephemeralSecretKey?: KeyLike;
  /** Ignored: HPKE derives the AEAD nonce from the key schedule. Kept for EMKW1-era callers. */
  nonce?: Uint8Array;
}

export interface ParsedWrappedKey {
  /** HPKE encapsulated key (the sender's ephemeral X25519 public key). */
  enc: Uint8Array;
  /** Alias of `enc`. */
  ephemeralPublicKey: Uint8Array;
  /** HPKE ciphertext (wrapped key ‖ tag). */
  ciphertext: Uint8Array;
}

export function parseWrappedKey(blob: Uint8Array): ParsedWrappedKey {
  if (!startsWith(blob, KW_MAGIC_BYTES)) throw new Error('EMKW2: bad magic');
  if (blob.length !== WRAPPED_KEY_LEN) throw new Error(`EMKW2: expected ${WRAPPED_KEY_LEN} bytes, got ${blob.length}`);
  const o = KW_MAGIC_BYTES.length;
  const enc = blob.subarray(o, o + ENC_LEN);
  return { enc, ephemeralPublicKey: enc, ciphertext: blob.subarray(o + ENC_LEN) };
}

export interface UnwrapKeyArgs {
  blob: Uint8Array;
  recipientSecretKey: KeyLike;
  wrapperHash: KeyLike;
  info?: string;
}

const AUTH_FAIL = 'EMKW2: authentication failed (wrong recipient key, wrong wrapperHash/info, or tampered blob)';

/** HPKE-wrap a key into the EMKW2 format (synchronous; byte-identical to `wrapKeyAsync`). */
export function wrapKey(args: WrapKeyArgs): Uint8Array {
  const { enc, ct } = hpkeSealBase({
    recipientPublicKey: args.recipientPublicKey,
    info: utf8(args.info ?? KEYWRAP_INFO),
    aad: keyBytes(args.wrapperHash, 'wrapperHash'),
    plaintext: keyBytes(args.key, 'key'),
    ephemeralSecretKey: args.ephemeralSecretKey,
  });
  return concatBytes(KW_MAGIC_BYTES, enc, ct);
}

/** Unwrap an EMKW2 blob (synchronous). Throws on wrong key, wrong wrapperHash/info or tampering. */
export function unwrapKey(args: UnwrapKeyArgs): Uint8Array {
  const { enc, ciphertext } = parseWrappedKey(args.blob);
  const aad = keyBytes(args.wrapperHash, 'wrapperHash');
  let key: Uint8Array;
  try {
    key = hpkeOpenBase({ recipientSecretKey: args.recipientSecretKey, enc, info: utf8(args.info ?? KEYWRAP_INFO), aad, ct: ciphertext });
  } catch (e) {
    if (/^X25519: invalid key/.test((e as Error).message)) throw e;
    throw new Error(AUTH_FAIL);
  }
  if (key.length !== KEY_LEN) throw new Error(`EMKW2: unwrapped key has length ${key.length}`);
  return key;
}

let suite: CipherSuite | undefined;

/** The @hpke/core suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM. */
export function hpkeSuite(): CipherSuite {
  return (suite ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }));
}

/** EMKW2 wrap with @hpke/core (reference implementation). */
export async function wrapKeyAsync(args: WrapKeyArgs): Promise<Uint8Array> {
  const s = hpkeSuite();
  const recipientPublicKey = await s.kem.deserializePublicKey(keyBytes(args.recipientPublicKey, 'recipientPublicKey'));
  let ekm: Parameters<CipherSuite['seal']>[0]['ekm'];
  if (args.ephemeralSecretKey) {
    const skE = keyBytes(args.ephemeralSecretKey, 'ephemeralSecretKey');
    ekm = { privateKey: await s.kem.deserializePrivateKey(skE), publicKey: await s.kem.deserializePublicKey(x25519.getPublicKey(skE)) };
  }
  const { ct, enc } = await s.seal(
    { recipientPublicKey, info: utf8(args.info ?? KEYWRAP_INFO), ekm },
    keyBytes(args.key, 'key'),
    keyBytes(args.wrapperHash, 'wrapperHash'),
  );
  return concatBytes(KW_MAGIC_BYTES, new Uint8Array(enc), new Uint8Array(ct));
}

/** EMKW2 unwrap with @hpke/core (reference implementation). */
export async function unwrapKeyAsync(args: UnwrapKeyArgs): Promise<Uint8Array> {
  const { enc, ciphertext } = parseWrappedKey(args.blob);
  const s = hpkeSuite();
  const recipientKey = await s.kem.deserializePrivateKey(keyBytes(args.recipientSecretKey, 'recipientSecretKey'));
  let key: Uint8Array;
  try {
    key = new Uint8Array(await s.open({ recipientKey, enc, info: utf8(args.info ?? KEYWRAP_INFO) }, ciphertext, keyBytes(args.wrapperHash, 'wrapperHash')));
  } catch {
    throw new Error(AUTH_FAIL);
  }
  if (key.length !== KEY_LEN) throw new Error(`EMKW2: unwrapped key has length ${key.length}`);
  return key;
}

/* ------------------------------------- hashes ------------------------------------- */

/** wrappedKeyHash = sha256(blob). */
export function wrappedKeyHash(blob: Uint8Array): Hex {
  return sha256Hex(blob);
}

/** ciphertextHash = sha256(encrypted file). */
export function ciphertextHash(blob: Uint8Array): Hex {
  return sha256Hex(blob);
}

/** 0x-hex helpers. */
export function toHex0x(b: Uint8Array): Hex {
  return bytesToHex(b);
}
export function fromHex0x(h: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new TypeError(`not 0x-hex: ${h.slice(0, 20)}`);
  return hexToBytes(h as Hex);
}

/** base64 helpers (HTTP payloads). */
export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

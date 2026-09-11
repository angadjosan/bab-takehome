/**
 * Encryption formats.
 *
 * EMENC1 (bundle / audit asset): "EMENC1" (6) ‖ nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16); no AAD.
 *   Implemented with the platform AES-GCM (node:crypto / OpenSSL).
 *
 * EMKW2 (wrapped key): "EMKW2" (5) ‖ enc (32) ‖ HPKE ciphertext (32-byte key ‖ 16-byte tag) = 85 bytes.
 *   HPKE (RFC 9180) via @hpke/core + @hpke/dhkem-x25519, mode_base, single shot, suite
 *     KEM  DHKEM(X25519, HKDF-SHA256)  0x0020
 *     KDF  HKDF-SHA256                 0x0001
 *     AEAD AES-256-GCM                 0x0002
 *   info = "envmarket.keywrap.v1" (deliveries) or "envmarket.upload.v1" (seller → TEE upload);
 *   aad  = the 32 wrapperHash bytes (for uploads: the ciphertextHash), which binds the wrapped key
 *          to the buyer-specific delivery wrapper.
 *
 * X25519 keys are raw 32-byte values rendered as 0x-hex (bytes32 on-chain), which is exactly the
 * RFC 9180 SerializePublicKey/SerializePrivateKey encoding for X25519. No custom crypto: key
 * wrapping is @hpke/core, AES-GCM is the platform's, X25519 key generation is @noble/curves.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { x25519 } from '@noble/curves/ed25519.js';
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

/* ------------------------------ EMENC1: AES-256-GCM (platform) ------------------------------ */

/** Encrypt into the EMENC1 file format. `nonce` is random unless given (tests only). */
export function encryptFile(key: KeyLike, plaintext: Uint8Array, nonce?: Uint8Array): Uint8Array {
  const n = nonce ?? randomBytes(NONCE_LEN);
  if (n.length !== NONCE_LEN) throw new Error('EMENC1: nonce must be 12 bytes');
  const c = createCipheriv('aes-256-gcm', keyBytes(key, 'key'), n, { authTagLength: TAG_LEN });
  return concatBytes(ENC_MAGIC_BYTES, n, c.update(plaintext), c.final(), c.getAuthTag());
}

/** Decrypt an EMENC1 file. Throws on wrong magic, truncation, wrong key or tampering. */
export function decryptFile(key: KeyLike, blob: Uint8Array): Uint8Array {
  if (!startsWith(blob, ENC_MAGIC_BYTES)) throw new Error('EMENC1: bad magic');
  const minLen = ENC_MAGIC_BYTES.length + NONCE_LEN + TAG_LEN;
  if (blob.length < minLen) throw new Error('EMENC1: truncated');
  const n = blob.subarray(ENC_MAGIC_BYTES.length, ENC_MAGIC_BYTES.length + NONCE_LEN);
  const body = blob.subarray(ENC_MAGIC_BYTES.length + NONCE_LEN, blob.length - TAG_LEN);
  const k = keyBytes(key, 'key');
  try {
    const d = createDecipheriv('aes-256-gcm', k, n, { authTagLength: TAG_LEN });
    d.setAuthTag(blob.subarray(blob.length - TAG_LEN));
    return concatBytes(d.update(body), d.final());
  } catch {
    throw new Error('EMENC1: authentication failed (wrong key or tampered ciphertext)');
  }
}

/* ------------------------------------ X25519 keys ------------------------------------ */

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

/** Raw X25519 shared secret; rejects low-order (all-zero) results. */
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

/* ---------------------------------- EMKW2 key wrap (HPKE) ---------------------------------- */

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

let suite: CipherSuite | undefined;

/** The @hpke/core suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM. */
export function hpkeSuite(): CipherSuite {
  return (suite ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }));
}

/** HPKE-wrap a 32-byte key into the EMKW2 format (@hpke/core). */
export async function wrapKey(args: WrapKeyArgs): Promise<Uint8Array> {
  const pkR = keyBytes(args.recipientPublicKey, 'recipientPublicKey');
  if (equalBytes(pkR, new Uint8Array(32))) throw new Error('X25519: low-order public key');
  const s = hpkeSuite();
  let recipientPublicKey: Awaited<ReturnType<CipherSuite['kem']['deserializePublicKey']>>;
  try {
    recipientPublicKey = await s.kem.deserializePublicKey(pkR);
  } catch (e) {
    throw new Error(`X25519: invalid key (${(e as Error).message})`);
  }
  let ekm: Parameters<CipherSuite['seal']>[0]['ekm'];
  if (args.ephemeralSecretKey) {
    const skE = keyBytes(args.ephemeralSecretKey, 'ephemeralSecretKey');
    ekm = { privateKey: await s.kem.deserializePrivateKey(skE), publicKey: await s.kem.deserializePublicKey(x25519.getPublicKey(skE)) };
  }
  let sealed: Awaited<ReturnType<CipherSuite['seal']>>;
  try {
    sealed = await s.seal({ recipientPublicKey, info: utf8(args.info ?? KEYWRAP_INFO), ekm }, keyBytes(args.key, 'key'), keyBytes(args.wrapperHash, 'wrapperHash'));
  } catch (e) {
    throw new Error(`X25519/HPKE: cannot wrap to this key (${(e as Error).message})`);
  }
  return concatBytes(KW_MAGIC_BYTES, new Uint8Array(sealed.enc), new Uint8Array(sealed.ct));
}

/** Unwrap an EMKW2 blob (@hpke/core). Throws on wrong key, wrong wrapperHash/info or tampering. */
export async function unwrapKey(args: UnwrapKeyArgs): Promise<Uint8Array> {
  const { enc, ciphertext } = parseWrappedKey(args.blob);
  const s = hpkeSuite();
  const recipientKey = await s.kem.deserializePrivateKey(keyBytes(args.recipientSecretKey, 'recipientSecretKey'));
  let key: Uint8Array;
  try {
    key = new Uint8Array(await s.open({ recipientKey, enc, info: utf8(args.info ?? KEYWRAP_INFO) }, ciphertext, keyBytes(args.wrapperHash, 'wrapperHash')));
  } catch {
    throw new Error('EMKW2: authentication failed (wrong recipient key, wrong wrapperHash/info, or tampered blob)');
  }
  if (key.length !== KEY_LEN) throw new Error(`EMKW2: unwrapped key has length ${key.length}`);
  return key;
}

/** Alias of `wrapKey` (the name callers used while the synchronous shim existed). */
export const wrapKeyAsync = wrapKey;
/** Alias of `unwrapKey`. */
export const unwrapKeyAsync = unwrapKey;

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

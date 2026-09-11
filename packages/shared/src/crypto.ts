/**
 * Encryption formats.
 *
 * EMENC1 (bundle / audit asset):  "EMENC1" (6) ‖ nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16); no AAD.
 * EMKW1  (wrapped key, ECIES):     "EMKW1" (5) ‖ eph_pk (32) ‖ nonce (12) ‖ AES-256-GCM(kek, key) ‖ tag (16); no AAD.
 *   shared = X25519(eph_sk, recipientPk)
 *   kek    = HKDF-SHA256(ikm = shared, salt = wrapperHash bytes (32), info = "envmarket.keywrap.v1", L = 32)
 *
 * Implemented with @noble (audited, pure JS) and interoperable with node:crypto / OpenSSL
 * (see tests). X25519 keys are raw 32-byte values rendered as 0x-hex (bytes32 on-chain).
 */
import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Hex } from 'viem';
import { bytes32ToBytes, bytesToHex, concatBytes, equalBytes, hexToBytes, sha256Hex, utf8 } from './hash.ts';

export const ENC_MAGIC = 'EMENC1';
export const KEYWRAP_MAGIC = 'EMKW1';
export const KEYWRAP_INFO = 'envmarket.keywrap.v1';
/** HKDF info for keys wrapped by the seller to the TEE service's X25519 key (upload path). */
export const UPLOAD_KEYWRAP_INFO = 'envmarket.upload.v1';

const ENC_MAGIC_BYTES = utf8(ENC_MAGIC);
const KW_MAGIC_BYTES = utf8(KEYWRAP_MAGIC);
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
export const WRAPPED_KEY_LEN = KW_MAGIC_BYTES.length + 32 + NONCE_LEN + KEY_LEN + TAG_LEN; // 97

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

/** Encrypt into the EMENC1 file format. `nonce` is random unless given (tests only). */
export function encryptFile(key: KeyLike, plaintext: Uint8Array, nonce?: Uint8Array): Uint8Array {
  const n = nonce ?? randomBytes(NONCE_LEN);
  if (n.length !== NONCE_LEN) throw new Error('EMENC1: nonce must be 12 bytes');
  const ct = gcm(keyBytes(key, 'key'), n).encrypt(plaintext); // ciphertext ‖ tag
  return concatBytes(ENC_MAGIC_BYTES, n, ct);
}

/** Decrypt an EMENC1 file. Throws on wrong magic, truncation, wrong key or tampering. */
export function decryptFile(key: KeyLike, blob: Uint8Array): Uint8Array {
  if (!startsWith(blob, ENC_MAGIC_BYTES)) throw new Error('EMENC1: bad magic');
  const minLen = ENC_MAGIC_BYTES.length + NONCE_LEN + TAG_LEN;
  if (blob.length < minLen) throw new Error('EMENC1: truncated');
  const n = blob.subarray(ENC_MAGIC_BYTES.length, ENC_MAGIC_BYTES.length + NONCE_LEN);
  const ct = blob.subarray(ENC_MAGIC_BYTES.length + NONCE_LEN);
  try {
    return gcm(keyBytes(key, 'key'), n).decrypt(ct);
  } catch {
    throw new Error('EMENC1: authentication failed (wrong key or tampered ciphertext)');
  }
}

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

/** HKDF-SHA256 key-encryption key. */
export function deriveKek(shared: Uint8Array, salt: KeyLike, info: string = KEYWRAP_INFO): Uint8Array {
  return hkdf(sha256, shared, keyBytes(salt, 'salt'), utf8(info), KEY_LEN);
}

export interface WrapKeyArgs {
  /** The 32-byte symmetric key to wrap (e.g. K_bundle). */
  key: KeyLike;
  /** Recipient X25519 public key (buyerEncPubKey). */
  recipientPublicKey: KeyLike;
  /** HKDF salt; for deliveries this is the wrapperHash. */
  wrapperHash: KeyLike;
  /** HKDF info; default "envmarket.keywrap.v1". */
  info?: string;
  /** Deterministic ephemeral key / nonce (tests only). */
  ephemeralSecretKey?: KeyLike;
  nonce?: Uint8Array;
}

/** ECIES-wrap a key into the EMKW1 format. */
export function wrapKey(args: WrapKeyArgs): Uint8Array {
  const ephSk = args.ephemeralSecretKey ? keyBytes(args.ephemeralSecretKey, 'ephemeralSecretKey') : x25519.utils.randomSecretKey();
  const ephPk = x25519.getPublicKey(ephSk);
  const shared = x25519SharedSecret(ephSk, args.recipientPublicKey);
  const kek = deriveKek(shared, args.wrapperHash, args.info ?? KEYWRAP_INFO);
  const nonce = args.nonce ?? randomBytes(NONCE_LEN);
  if (nonce.length !== NONCE_LEN) throw new Error('EMKW1: nonce must be 12 bytes');
  const ct = gcm(kek, nonce).encrypt(keyBytes(args.key, 'key'));
  return concatBytes(KW_MAGIC_BYTES, ephPk, nonce, ct);
}

export interface ParsedWrappedKey {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array; // includes tag
}

export function parseWrappedKey(blob: Uint8Array): ParsedWrappedKey {
  if (!startsWith(blob, KW_MAGIC_BYTES)) throw new Error('EMKW1: bad magic');
  if (blob.length !== WRAPPED_KEY_LEN) throw new Error(`EMKW1: expected ${WRAPPED_KEY_LEN} bytes, got ${blob.length}`);
  let o = KW_MAGIC_BYTES.length;
  const ephemeralPublicKey = blob.subarray(o, o + 32);
  o += 32;
  const nonce = blob.subarray(o, o + NONCE_LEN);
  o += NONCE_LEN;
  return { ephemeralPublicKey, nonce, ciphertext: blob.subarray(o) };
}

export interface UnwrapKeyArgs {
  blob: Uint8Array;
  recipientSecretKey: KeyLike;
  wrapperHash: KeyLike;
  info?: string;
}

/** Unwrap an EMKW1 blob. Throws on wrong key, wrong wrapperHash or tampering. */
export function unwrapKey(args: UnwrapKeyArgs): Uint8Array {
  const { ephemeralPublicKey, nonce, ciphertext } = parseWrappedKey(args.blob);
  const shared = x25519SharedSecret(args.recipientSecretKey, ephemeralPublicKey);
  const kek = deriveKek(shared, args.wrapperHash, args.info ?? KEYWRAP_INFO);
  try {
    return gcm(kek, nonce).decrypt(ciphertext);
  } catch {
    throw new Error('EMKW1: authentication failed (wrong recipient key, wrong wrapperHash, or tampered blob)');
  }
}

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

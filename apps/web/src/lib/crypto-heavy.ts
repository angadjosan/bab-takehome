"use client";

/**
 * The heavy half of the browser crypto: X25519 key generation/import, HPKE key unwrap and AES-GCM bundle
 * decryption. Split from ./crypto (hashes, canonical JSON, tar listing) so pages only download these
 * libraries when someone clicks generate, import or download — load it with `await import("@/lib/crypto-heavy")`.
 */
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { utf8, type EncKey } from "./crypto";

/* ------------------------- Buyer encryption keys (X25519) ------------------------- */

export function generateEncKey(): EncKey {
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  return { publicKey: bytesToHex(pk), secretKey: bytesToHex(sk), createdAt: Date.now() };
}

export function encKeyFromSecret(secretHex: string): EncKey {
  const clean = secretHex.trim().startsWith("0x") ? secretHex.trim() : `0x${secretHex.trim()}`;
  const sk = hexToBytes(clean as Hex);
  if (sk.length !== 32) throw new Error("Secret key must be 32 bytes (64 hex characters)");
  return { publicKey: bytesToHex(x25519.getPublicKey(sk)), secretKey: bytesToHex(sk), createdAt: Date.now(), label: "imported" };
}

/* --------------------------- Envelope formats (spec) --------------------------- */

const MAGIC_KW = utf8("EMKW2");
const MAGIC_ENC = utf8("EMENC1");
const KEYWRAP_INFO = utf8("envmarket.keywrap.v1");
const WRAPPED_KEY_LEN = 85; // "EMKW2"(5) + enc(32) + key(32) + tag(16)

function startsWith(buf: Uint8Array, magic: Uint8Array) {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

/**
 * EMKW2 wrapped key (same format as packages/shared wrapKey/unwrapKey):
 *   blob = "EMKW2" ‖ enc(32) ‖ HPKE ciphertext(48)
 *   HPKE (RFC 9180) mode_base, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM,
 *   info = "envmarket.keywrap.v1", aad = the 32 wrapperHash bytes.
 */
function parseWrappedKey(blob: Uint8Array): { enc: Uint8Array; ct: Uint8Array } {
  if (!startsWith(blob, MAGIC_KW)) throw new Error("Wrapped key does not start with EMKW2 magic");
  if (blob.length !== WRAPPED_KEY_LEN) throw new Error(`Wrapped key must be ${WRAPPED_KEY_LEN} bytes, got ${blob.length}`);
  return { enc: blob.slice(5, 37), ct: blob.slice(37) };
}

let hpkeSuite: CipherSuite | undefined;
const suite = () => (hpkeSuite ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }));

/** Unwrap the buyer-specific bundle key with @hpke/core (WebCrypto). */
export async function unwrapBundleKeyAsync(blob: Uint8Array, secretKey: Hex, wrapperHash: Hex): Promise<Uint8Array> {
  const { enc, ct } = parseWrappedKey(blob);
  const s = suite();
  const recipientKey = await s.kem.deserializePrivateKey(hexToBytes(secretKey));
  const key = new Uint8Array(await s.open({ recipientKey, enc, info: KEYWRAP_INFO }, ct, hexToBytes(wrapperHash)));
  if (key.length !== 32) throw new Error(`Unwrapped key has unexpected length ${key.length}`);
  return key;
}

/** file = "EMENC1" ‖ nonce(12) ‖ ciphertext ‖ tag(16) */
export function decryptBundle(file: Uint8Array, key: Uint8Array): Uint8Array {
  if (!startsWith(file, MAGIC_ENC)) throw new Error("Ciphertext does not start with EMENC1 magic");
  const nonce = file.slice(MAGIC_ENC.length, MAGIC_ENC.length + 12);
  return gcm(key, nonce).decrypt(file.slice(MAGIC_ENC.length + 12));
}

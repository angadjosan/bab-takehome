import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { bytesToHex, hexToBytes, type Hex } from "viem";

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function sha256Hex(data: Uint8Array | string): Hex {
  return bytesToHex(sha256(typeof data === "string" ? utf8(data) : data));
}

/** Canonical JSON = RFC 8785 (JCS) via `canonicalize`, the same serializer as packages/shared canonicalJson. */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error("canonicalJson: value has no JSON form");
  return out;
}

export function eqHash(a?: string | null, b?: string | null) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------- Buyer encryption keys (X25519) ------------------------- */

export type EncKey = { publicKey: Hex; secretKey: Hex; createdAt: number; label?: string };

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

/** Unwrap the buyer-specific bundle key with @hpke/core (reference implementation, WebCrypto). */
export async function unwrapBundleKeyAsync(blob: Uint8Array, secretKey: Hex, wrapperHash: Hex): Promise<Uint8Array> {
  const { enc, ct } = parseWrappedKey(blob);
  const s = suite();
  const recipientKey = await s.kem.deserializePrivateKey(hexToBytes(secretKey));
  const key = new Uint8Array(await s.open({ recipientKey, enc, info: KEYWRAP_INFO }, ct, hexToBytes(wrapperHash)));
  if (key.length !== 32) throw new Error(`Unwrapped key has unexpected length ${key.length}`);
  return key;
}

// Synchronous RFC 9180 base-mode open over @noble primitives, for synchronous callers. Byte-for-byte
// the same as @hpke/core; packages/shared/test/web-crypto.test.ts checks both against shared's wrapKey.
const i2osp2 = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE = concatBytes(utf8("KEM"), i2osp2(0x0020));
const HPKE_SUITE = concatBytes(utf8("HPKE"), i2osp2(0x0020), i2osp2(0x0001), i2osp2(0x0002));
const EMPTY = new Uint8Array(0);
const labeledExtract = (sid: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(sha256, concatBytes(HPKE_V1, sid, utf8(label), ikm), salt);
const labeledExpand = (sid: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(sha256, prk, concatBytes(i2osp2(len), HPKE_V1, sid, utf8(label), info), len);

/** Unwrap the buyer-specific bundle key (synchronous; same result as unwrapBundleKeyAsync). */
export function unwrapBundleKey(blob: Uint8Array, secretKey: Hex, wrapperHash: Hex): Uint8Array {
  const { enc, ct } = parseWrappedKey(blob);
  const skR = hexToBytes(secretKey);
  const dh = x25519.getSharedSecret(skR, enc);
  if (dh.every((b) => b === 0)) throw new Error("Wrapped key uses a low-order X25519 point");
  const kemContext = concatBytes(enc, x25519.getPublicKey(skR));
  const sharedSecret = labeledExpand(KEM_SUITE, labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh), "shared_secret", kemContext, 32);
  const ctx = concatBytes(new Uint8Array([0]), labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY), labeledExtract(HPKE_SUITE, EMPTY, "info_hash", KEYWRAP_INFO));
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  const key = labeledExpand(HPKE_SUITE, secret, "key", ctx, 32);
  const nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, 12);
  const out = gcm(key, nonce, hexToBytes(wrapperHash)).decrypt(ct);
  if (out.length !== 32) throw new Error(`Unwrapped key has unexpected length ${out.length}`);
  return out;
}

/** file = "EMENC1" ‖ nonce(12) ‖ ciphertext ‖ tag(16) */
export function decryptBundle(file: Uint8Array, key: Uint8Array): Uint8Array {
  if (!startsWith(file, MAGIC_ENC)) throw new Error("Ciphertext does not start with EMENC1 magic");
  const nonce = file.slice(MAGIC_ENC.length, MAGIC_ENC.length + 12);
  return gcm(key, nonce).decrypt(file.slice(MAGIC_ENC.length + 12));
}

/* ------------------------------ ustar listing ------------------------------ */

export type TarEntry = { path: string; size: number; type: "file" | "dir" | "other" };

export function listTar(tar: Uint8Array): TarEntry[] {
  const dec = new TextDecoder();
  const str = (a: number, b: number) => dec.decode(tar.subarray(a, b)).replace(/\0.*$/s, "");
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = str(off, off + 100);
    const prefix = str(off + 345, off + 500);
    const size = parseInt(str(off + 124, off + 136).trim() || "0", 8) || 0;
    const flag = String.fromCharCode(tar[off + 156] || 48);
    const path = prefix ? `${prefix}/${name}` : name;
    entries.push({ path, size, type: flag === "5" ? "dir" : flag === "0" || flag === "\0" ? "file" : "other" });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

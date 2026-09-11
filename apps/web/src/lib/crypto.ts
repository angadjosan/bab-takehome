import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function sha256Hex(data: Uint8Array | string): Hex {
  return bytesToHex(sha256(typeof data === "string" ? utf8(data) : data));
}

/** Canonical JSON: object keys sorted, no whitespace (matches packages/shared canonicalJson). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
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

const MAGIC_KW = utf8("EMKW1");
const MAGIC_ENC = utf8("EMENC1");

function startsWith(buf: Uint8Array, magic: Uint8Array) {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

/**
 * Unwrap the buyer-specific bundle key.
 * blob = "EMKW1" ‖ eph_pk(32) ‖ nonce(12) ‖ AES-256-GCM(kek, K_bundle) ‖ tag(16)
 * kek  = HKDF-SHA256(ikm = X25519(sk, eph_pk), salt = wrapperHash, info = "envmarket.keywrap.v1", 32)
 */
export function unwrapBundleKey(blob: Uint8Array, secretKey: Hex, wrapperHash: Hex): Uint8Array {
  if (!startsWith(blob, MAGIC_KW)) throw new Error("Wrapped key does not start with EMKW1 magic");
  let o = MAGIC_KW.length;
  const ephPk = blob.slice(o, (o += 32));
  const nonce = blob.slice(o, (o += 12));
  const sealed = blob.slice(o);
  const shared = x25519.getSharedSecret(hexToBytes(secretKey), ephPk);
  const kek = hkdf(sha256, shared, hexToBytes(wrapperHash), utf8("envmarket.keywrap.v1"), 32);
  const key = gcm(kek, nonce).decrypt(sealed);
  if (key.length !== 32) throw new Error(`Unwrapped key has unexpected length ${key.length}`);
  return key;
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

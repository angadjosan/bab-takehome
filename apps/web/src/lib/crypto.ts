// Light helpers only. X25519 keys, HPKE unwrap and AES-GCM decryption live in ./crypto-heavy, loaded on demand.
import { sha256 } from "@noble/hashes/sha2.js";
import canonicalize from "canonicalize";
import { bytesToHex, type Hex } from "viem";

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

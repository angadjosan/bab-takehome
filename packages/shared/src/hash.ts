/**
 * Hash helpers and canonical JSON.
 *
 * Conventions (BUILD_SPEC "Commitments and file formats"):
 * - content digests are sha256, rendered as lowercase `0x` + 64 hex (bytes32);
 * - on-chain structural hashes are keccak256;
 * - strings passed to the sha256/keccak helpers are ALWAYS treated as UTF-8 text
 *   (never auto-decoded as hex). Use `hexToBytes` first if you mean raw bytes.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, keccak256, type Hex } from 'viem';

export type { Hex };
export { bytesToHex, hexToBytes };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encode a string. */
export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** Strict UTF-8 decode (throws on invalid sequences). */
export function fromUtf8(b: Uint8Array): string {
  return textDecoder.decode(b);
}

function asBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8(data) : data;
}

/** Raw sha256 digest (32 bytes). Strings are UTF-8 encoded. */
export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return nobleSha256(asBytes(data));
}

/** sha256 digest as lowercase 0x-prefixed bytes32. Strings are UTF-8 encoded. */
export function sha256Hex(data: Uint8Array | string): Hex {
  return bytesToHex(nobleSha256(asBytes(data)));
}

/** keccak256 of raw bytes or of a 0x-hex byte string (viem semantics). */
export function keccakHex(data: Uint8Array | Hex): Hex {
  return keccak256(data);
}

/** keccak256 of the UTF-8 bytes of a string (like Solidity `keccak256(bytes(s))`). */
export function keccakUtf8(s: string): Hex {
  return keccak256(utf8(s));
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export function isBytes32(x: unknown): x is Hex {
  return typeof x === 'string' && BYTES32_RE.test(x);
}

/** Validate and lowercase a bytes32 hex string. */
export function normalizeBytes32(x: string, name = 'value'): Hex {
  if (!isBytes32(x)) throw new TypeError(`${name} must be 0x-prefixed 32-byte hex, got ${JSON.stringify(x)}`);
  return x.toLowerCase() as Hex;
}

/** Decode a bytes32 hex string (or pass through 32 raw bytes). */
export function bytes32ToBytes(x: Hex | Uint8Array, name = 'value'): Uint8Array {
  if (x instanceof Uint8Array) {
    if (x.length !== 32) throw new TypeError(`${name} must be 32 bytes, got ${x.length}`);
    return x;
  }
  return hexToBytes(normalizeBytes32(x, name));
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Constant-time-ish byte equality (length leak only). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Canonical JSON: object keys sorted (by UTF-16 code units, i.e. default JS sort, same as
 * RFC 8785 for key ordering), no whitespace, `undefined` object members omitted, numbers in
 * shortest round-trip form (JSON.stringify), strings escaped as JSON.stringify does.
 *
 * Rejects values that have no stable JSON form: bigint (encode uint256 as a decimal string),
 * non-finite numbers, functions, symbols, `undefined` inside arrays, Uint8Array, Date and other
 * non-plain objects.
 */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, '$');
}

function encodeCanonical(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v); // -0 -> "0"
    case 'bigint':
      throw new TypeError(`canonicalJson: bigint at ${path}; encode as a decimal string`);
    case 'object': {
      if (Array.isArray(v)) {
        return (
          '[' +
          v
            .map((x, i) => {
              if (x === undefined || typeof x === 'function' || typeof x === 'symbol') {
                throw new TypeError(`canonicalJson: unsupported array element at ${path}[${i}]`);
              }
              return encodeCanonical(x, `${path}[${i}]`);
            })
            .join(',') +
          ']'
        );
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: non-plain object at ${path}`);
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return (
        '{' +
        keys
          .map((k) => {
            const x = obj[k];
            if (typeof x === 'function' || typeof x === 'symbol') {
              throw new TypeError(`canonicalJson: unsupported value at ${path}.${k}`);
            }
            return JSON.stringify(k) + ':' + encodeCanonical(x, `${path}.${k}`);
          })
          .join(',') +
        '}'
      );
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** Canonical JSON as UTF-8 bytes. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

/** sha256 over the UTF-8 bytes of the canonical JSON of `value`. */
export function sha256Canonical(value: unknown): Hex {
  return sha256Hex(canonicalJson(value));
}

/** True iff `text` is exactly the canonical serialization of the JSON it contains. */
export function isCanonicalJson(text: string): boolean {
  try {
    return canonicalJson(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}

/** Parse JSON text, requiring it to already be in canonical form. */
export function parseCanonicalJson<T = unknown>(text: string | Uint8Array): T {
  const s = typeof text === 'string' ? text : fromUtf8(text);
  const parsed = JSON.parse(s) as T;
  if (canonicalJson(parsed) !== s) throw new Error('JSON is not in canonical form');
  return parsed;
}

/**
 * Storage.
 *
 * BlobStore: public, content-addressed (sha256) files under DATA_DIR/blobs/<64hex>. Holds only
 * public documents (description, manifest, report, findings summaries) and ciphertexts.
 *
 * PrivateStore: records that must never leave the TEE in plaintext (bundle/audit keys, salts,
 * private run records, delivery ephemeral keys, evidence, access logs). Each record is
 * AES-256-GCM encrypted with the mnemonic-derived storage key; the record's namespace/id is bound
 * as AAD so encrypted files cannot be swapped between slots. Format: "EMPRV1" ‖ nonce(12) ‖ ct ‖ tag.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@envmarket/shared';
import { sha256Hex } from '@envmarket/shared';
import type { Hex } from 'viem';

const HEX64 = /^0x[0-9a-f]{64}$/;

export function normHash(h: string): Hex {
  const x = (h.startsWith('0x') ? h : `0x${h}`).toLowerCase();
  if (!HEX64.test(x)) throw new Error(`bad sha256 digest: ${h.slice(0, 80)}`);
  return x as Hex;
}

function atomicWrite(file: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class BlobStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  pathOf(hash: string): string {
    return path.join(this.dir, normHash(hash).slice(2));
  }
  put(data: Uint8Array | string): Hex {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const h = sha256Hex(bytes);
    const p = this.pathOf(h);
    if (!fs.existsSync(p)) atomicWrite(p, bytes);
    return h;
  }
  has(hash: string): boolean {
    try {
      return fs.existsSync(this.pathOf(hash));
    } catch {
      return false;
    }
  }
  get(hash: string): Uint8Array | null {
    const p = this.pathOf(hash);
    if (!fs.existsSync(p)) return null;
    const b = new Uint8Array(fs.readFileSync(p));
    if (sha256Hex(b) !== normHash(hash)) throw new Error(`blob ${hash} corrupted on disk`);
    return b;
  }
  getText(hash: string): string | null {
    const b = this.get(hash);
    return b ? new TextDecoder().decode(b) : null;
  }
}

const MAGIC = new TextEncoder().encode('EMPRV1');
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export class PrivateStore {
  readonly dir: string;
  #key: Uint8Array;
  constructor(dataDir: string, key: Uint8Array) {
    if (key.length !== 32) throw new Error('storage key must be 32 bytes');
    this.dir = path.join(dataDir, 'private');
    this.#key = key;
    fs.mkdirSync(this.dir, { recursive: true });
  }
  #file(ns: string, id: string): string {
    if (!ID_RE.test(ns) || !ID_RE.test(id)) throw new Error(`bad private record name ${ns}/${id}`);
    return path.join(this.dir, ns, `${id}.enc`);
  }
  #aad(ns: string, id: string): Uint8Array {
    return new TextEncoder().encode(`envmarket.private.v1:${ns}/${id}`);
  }
  seal(ns: string, id: string, plaintext: Uint8Array): Uint8Array {
    const nonce = randomBytes(12);
    const ct = gcm(this.#key, nonce, this.#aad(ns, id)).encrypt(plaintext);
    const out = new Uint8Array(MAGIC.length + 12 + ct.length);
    out.set(MAGIC, 0);
    out.set(nonce, MAGIC.length);
    out.set(ct, MAGIC.length + 12);
    return out;
  }
  open(ns: string, id: string, blob: Uint8Array): Uint8Array {
    for (let i = 0; i < MAGIC.length; i++) if (blob[i] !== MAGIC[i]) throw new Error('private record: bad magic');
    const nonce = blob.subarray(MAGIC.length, MAGIC.length + 12);
    return gcm(this.#key, nonce, this.#aad(ns, id)).decrypt(blob.subarray(MAGIC.length + 12));
  }
  putBytes(ns: string, id: string, data: Uint8Array): void {
    atomicWrite(this.#file(ns, id), this.seal(ns, id, data));
  }
  getBytes(ns: string, id: string): Uint8Array | null {
    const f = this.#file(ns, id);
    if (!fs.existsSync(f)) return null;
    return this.open(ns, id, new Uint8Array(fs.readFileSync(f)));
  }
  put<T>(ns: string, id: string, value: T): void {
    this.putBytes(ns, id, new TextEncoder().encode(JSON.stringify(value)));
  }
  get<T>(ns: string, id: string): T | null {
    const b = this.getBytes(ns, id);
    return b ? (JSON.parse(new TextDecoder().decode(b)) as T) : null;
  }
  has(ns: string, id: string): boolean {
    return fs.existsSync(this.#file(ns, id));
  }
  list(ns: string): string[] {
    const d = path.join(this.dir, ns);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.slice(0, -4))
      .sort();
  }
  /** Append an encrypted line to a private log (each line sealed separately; base64 per line). */
  appendLog(name: string, entry: unknown): void {
    const f = this.#file('logs', name).replace(/\.enc$/, '.jsonl.enc');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const line = this.seal('logs', name, new TextEncoder().encode(JSON.stringify({ at: new Date().toISOString(), ...(entry as object) })));
    fs.appendFileSync(f, Buffer.from(line).toString('base64') + '\n');
  }
  readLog(name: string): unknown[] {
    const f = this.#file('logs', name).replace(/\.enc$/, '.jsonl.enc');
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(new TextDecoder().decode(this.open('logs', name, new Uint8Array(Buffer.from(l, 'base64'))))));
  }
}

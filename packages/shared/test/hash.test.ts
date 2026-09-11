import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDeliveryWrapper, canonicalJson, isCanonicalJson, keccakUtf8, parseCanonicalJson, sha256Canonical, sha256Hex } from '../src/index.ts';
import { cast, hasCast } from './helpers.ts';

describe('hash', () => {
  it('sha256 known vectors', () => {
    expect(sha256Hex('abc')).toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new Uint8Array())).toBe('0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('keccak of empty string', () => {
    expect(keccakUtf8('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  it.skipIf(!hasCast)('keccakUtf8 matches cast keccak', () => {
    expect(keccakUtf8('envmarket.task.v1')).toBe(cast('keccak', 'envmarket.task.v1'));
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively, no whitespace, independent of insertion order', () => {
    const a = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } };
    const b = { a: { c: 'x', d: [3, { y: null, z: true }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256Canonical(a)).toBe(sha256Canonical(b));
  });

  it('is stable across parse/serialize round trips', () => {
    const v = { type: 'envmarket.report.v1', n: -0, f: 0.1, big: 1e21, u: 'héllo "q" \n  ', arr: [] };
    const s = canonicalJson(v);
    expect(canonicalJson(JSON.parse(s))).toBe(s);
    expect(isCanonicalJson(s)).toBe(true);
    expect(isCanonicalJson(JSON.stringify(v, null, 2))).toBe(false);
    expect(parseCanonicalJson(s)).toEqual(JSON.parse(s));
    expect(() => parseCanonicalJson('{"b":1,"a":2}')).toThrow(/canonical/);
  });

  // RFC 8785 test data; backslashes/special chars built from char codes to keep this file plain ASCII.
  const BS = String.fromCharCode(92);
  const C = (...cps: number[]) => String.fromCodePoint(...cps);

  it('RFC 8785 §3.2.3 example (JCS via `canonicalize`)', () => {
    const s = [BS + "u20ac", "$", BS + "u000F", BS + "u000a", "A'", BS + "u0042", BS + "u0022", BS + "u005c", BS + BS, BS + '"', BS + "/"].join("");
    const input = `{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "${s}", "literals": [null, true, false]}`;
    const out = [C(0x20ac), "$", BS + "u000f", BS + "n", "A'B", BS + '"', BS + BS, BS + BS, BS + '"', "/"].join("");
    expect(canonicalJson(JSON.parse(input))).toBe(`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${out}"}`);
  });

  it('RFC 8785 §3.2.3 key sorting by UTF-16 code units', () => {
    const names: Array<[string, string]> = [
      [C(0x20ac), 'Euro Sign'],
      [C(0x0d), 'Carriage Return'],
      [C(0xfb33), 'Hebrew Letter Dalet With Dagesh'],
      ['1', 'One'],
      [C(0x1f600), 'Emoji: Grinning Face'],
      [C(0x80), 'Control'],
      [C(0xf6), 'Latin Small Letter O With Diaeresis'],
    ];
    const obj = Object.fromEntries(names);
    const order = [C(0x0d), '1', C(0x80), C(0xf6), C(0x20ac), C(0x1f600), C(0xfb33)];
    expect(canonicalJson(obj)).toBe('{' + order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(',') + '}');
  });

  it('rejects lone surrogates (RFC 8785 §3.2.2.2; the pre-JCS encoder escaped them)', () => {
    expect(() => canonicalJson({ a: String.fromCharCode(0xd800) })).toThrow(/canonicalJson/);
  });

  it('same bytes as the pre-JCS encoder for every committed JSON document and a delivery wrapper', () => {
    const legacy = (v: unknown): string => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(legacy).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${legacy(o[k])}`).join(',')}}`;
    };
    const ws = fileURLToPath(new URL('../../../seller-workspace', import.meta.url));
    const files = fs.readdirSync(ws, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json') && !f.includes('node_modules'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(ws, f), 'utf8'));
      expect(canonicalJson(doc), f).toBe(legacy(doc));
    }
    const { json } = buildDeliveryWrapper({
      purchaseId: 12n,
      chainId: 8453,
      market: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      buyer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      buyerEncPubKey: `0x${'ab'.repeat(32)}`,
      versionId: 2n,
      bundleHash: sha256Hex('b'),
      ciphertextHash: sha256Hex('c'),
      issuedAt: 1_789_000_000,
      relay: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });
    expect(canonicalJson(JSON.parse(json))).toBe(json);
    expect(legacy(JSON.parse(json))).toBe(json);
  });

  it('omits undefined members, rejects unstable values', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/non-plain/);
    expect(() => canonicalJson({ b: new Uint8Array(1) })).toThrow(/non-plain/);
  });
});

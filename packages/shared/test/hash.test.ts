import { describe, expect, it } from 'vitest';
import { canonicalJson, isCanonicalJson, keccakUtf8, parseCanonicalJson, sha256Canonical, sha256Hex } from '../src/index.ts';
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

  it('omits undefined members, rejects unstable values', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/non-plain/);
    expect(() => canonicalJson({ b: new Uint8Array(1) })).toThrow(/non-plain/);
  });
});

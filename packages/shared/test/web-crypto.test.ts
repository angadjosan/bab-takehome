/**
 * The browser helpers in apps/web/src/lib/crypto.ts must open exactly what the TEE relay produces
 * with this package (EMKW2 / EMENC1) and canonicalize JSON identically (RFC 8785). Skipped when
 * the web app's dependencies are not installed.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson, encryptFile, generateX25519KeyPair, randomKey, sha256Hex, wrapKeyAsync } from '../src/index.ts';

const WEB = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const hasWeb = existsSync(`${WEB}node_modules/@hpke/core`) && existsSync(`${WEB}node_modules/canonicalize`);
// The web app splits its crypto: light helpers in crypto.ts, HPKE/AES-GCM/X25519 in crypto-heavy.ts (loaded on demand).
const loadWeb = async () => ({
  ...(await import('../../../apps/web/src/lib/crypto.ts')),
  ...(await import('../../../apps/web/src/lib/crypto-heavy.ts')),
});

describe.skipIf(!hasWeb)('apps/web crypto helpers interoperate with packages/shared', () => {
  it('unwrapBundleKeyAsync (@hpke/core) opens shared EMKW2; decryptBundle opens EMENC1', async () => {
    const web = await loadWeb();
    const buyer = generateX25519KeyPair();
    const k = randomKey();
    const wrapperHash = sha256Hex('wrapper');
    const blob = await wrapKeyAsync({ key: k, recipientPublicKey: buyer.publicKey, wrapperHash });
    expect(await web.unwrapBundleKeyAsync(blob, buyer.secretKey, wrapperHash)).toEqual(k);
    await expect(web.unwrapBundleKeyAsync(blob, buyer.secretKey, sha256Hex('other'))).rejects.toThrow();
    await expect(web.unwrapBundleKeyAsync(blob, generateX25519KeyPair().secretKey, wrapperHash)).rejects.toThrow();
    const pt = new TextEncoder().encode('bundle tar bytes');
    expect(web.decryptBundle(encryptFile(k, pt), k)).toEqual(pt);
  });

  it('canonicalJson is byte-identical', async () => {
    const web = await loadWeb();
    const doc = { b: [1, 2.5, { z: null, a: 'é €' }], a: 1e21, c: { y: true, x: -0 }, d: 'q"uote' };
    expect(web.canonicalJson(doc)).toBe(canonicalJson(doc));
  });
});

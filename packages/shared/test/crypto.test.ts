import * as nodeCrypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDeliveryWrapper,
  bytesToHex,
  ciphertextHash,
  decryptFile,
  encryptFile,
  generateX25519KeyPair,
  hexToBytes,
  KEYWRAP_INFO,
  parseWrappedKey,
  randomKey,
  sha256Hex,
  unwrapKey,
  wrapKey,
  wrappedKeyHash,
  WRAPPED_KEY_LEN,
  x25519PublicKey,
} from '../src/index.ts';

const enc = new TextEncoder();

describe('EMENC1 (AES-256-GCM)', () => {
  const key = randomKey();
  const pt = enc.encode('the canonical bundle tar bytes'.repeat(100));

  it('round trips; format is magic ‖ nonce ‖ ct ‖ tag', () => {
    const blob = encryptFile(key, pt);
    expect(Buffer.from(blob.subarray(0, 6)).toString()).toBe('EMENC1');
    expect(blob.length).toBe(6 + 12 + pt.length + 16);
    expect(decryptFile(key, blob)).toEqual(pt);
    expect(decryptFile(bytesToHex(key), blob)).toEqual(pt);
  });

  it('fresh nonce per encryption', () => {
    expect(ciphertextHash(encryptFile(key, pt))).not.toBe(ciphertextHash(encryptFile(key, pt)));
  });

  it('detects tampering anywhere and wrong keys', () => {
    const blob = encryptFile(key, pt);
    for (const pos of [0, 7, 6 + 12 + 5, blob.length - 1]) {
      const t = new Uint8Array(blob);
      t[pos]! ^= 0x01;
      expect(() => decryptFile(key, t)).toThrow();
    }
    expect(() => decryptFile(randomKey(), blob)).toThrow(/authentication/);
    expect(() => decryptFile(key, blob.subarray(0, 20))).toThrow();
  });

  it('interoperates with node:crypto (OpenSSL) AES-256-GCM', () => {
    const blob = encryptFile(key, pt);
    const nonce = blob.subarray(6, 18);
    const body = blob.subarray(18, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(body), d.final()]);
    expect(new Uint8Array(out)).toEqual(pt);

    // and the other direction
    const n2 = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, n2);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    const fromNode = new Uint8Array(Buffer.concat([Buffer.from('EMENC1'), n2, ct, c.getAuthTag()]));
    expect(decryptFile(key, fromNode)).toEqual(pt);
  });
});

// DER wrappers for raw X25519 keys (RFC 8410)
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const nodePriv = (sk: Uint8Array) => nodeCrypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, sk]), format: 'der', type: 'pkcs8' });
const nodePub = (pk: Uint8Array) => nodeCrypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, pk]), format: 'der', type: 'spki' });

describe('EMKW1 (X25519 ECIES key wrap)', () => {
  const buyer = generateX25519KeyPair();
  const kBundle = randomKey();
  const wrapperHash = sha256Hex('{"type":"envmarket.delivery.v1"}');

  it('keypair public key derivation', () => {
    expect(x25519PublicKey(buyer.secretKey)).toBe(buyer.publicKey);
    expect(buyer.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('round trips; layout and length', () => {
    const blob = wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    expect(blob.length).toBe(WRAPPED_KEY_LEN);
    expect(Buffer.from(blob.subarray(0, 5)).toString()).toBe('EMKW1');
    expect(unwrapKey({ blob, recipientSecretKey: buyer.secretKey, wrapperHash })).toEqual(kBundle);
    expect(wrappedKeyHash(blob)).toBe(sha256Hex(blob));
  });

  it('fails with the wrong recipient key, wrong wrapperHash, or tampering', () => {
    const blob = wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    const other = generateX25519KeyPair();
    expect(() => unwrapKey({ blob, recipientSecretKey: other.secretKey, wrapperHash })).toThrow(/authentication/);
    expect(() => unwrapKey({ blob, recipientSecretKey: buyer.secretKey, wrapperHash: sha256Hex('other wrapper') })).toThrow(/authentication/);
    for (const pos of [0, 5, 5 + 32, 5 + 32 + 12, blob.length - 1]) {
      const t = new Uint8Array(blob);
      t[pos]! ^= 0x80;
      expect(() => unwrapKey({ blob: t, recipientSecretKey: buyer.secretKey, wrapperHash })).toThrow();
    }
  });

  it('rejects low-order recipient keys', () => {
    expect(() => wrapKey({ key: kBundle, recipientPublicKey: ('0x' + '00'.repeat(32)) as `0x${string}`, wrapperHash })).toThrow(/X25519/);
  });

  it('interoperates with node:crypto X25519 + HKDF + AES-GCM', () => {
    const blob = wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    const { ephemeralPublicKey, nonce, ciphertext } = parseWrappedKey(blob);
    const shared = nodeCrypto.diffieHellman({ privateKey: nodePriv(hexToBytes(buyer.secretKey)), publicKey: nodePub(ephemeralPublicKey) });
    const kek = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, hexToBytes(wrapperHash), Buffer.from(KEYWRAP_INFO), 32));
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', kek, nonce);
    d.setAuthTag(ciphertext.subarray(32));
    const key = Buffer.concat([d.update(ciphertext.subarray(0, 32)), d.final()]);
    expect(new Uint8Array(key)).toEqual(kBundle);

    // node public key derivation agrees with noble
    const pubDer = nodeCrypto.createPublicKey(nodePriv(hexToBytes(buyer.secretKey))).export({ format: 'der', type: 'spki' });
    expect(bytesToHex(new Uint8Array(pubDer.subarray(12)))).toBe(buyer.publicKey);
  });
});

describe('end-to-end delivery', () => {
  it('seller encrypts, relay wraps to buyer with wrapperHash, buyer decrypts', () => {
    const bundle = enc.encode('tar bytes');
    const kBundle = randomKey();
    const ct = encryptFile(kBundle, bundle);
    const buyer = generateX25519KeyPair();
    const { json, wrapperHash } = buildDeliveryWrapper({
      purchaseId: 3n,
      chainId: 8453,
      market: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      buyer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      buyerEncPubKey: buyer.publicKey,
      versionId: 1n,
      bundleHash: sha256Hex(bundle),
      ciphertextHash: ciphertextHash(ct),
      issuedAt: 1_789_000_000,
      relay: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });
    const wk = wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    // buyer side: verify the wrapper, derive the key, decrypt, check bundleHash
    expect(sha256Hex(json)).toBe(wrapperHash);
    const k = unwrapKey({ blob: wk, recipientSecretKey: buyer.secretKey, wrapperHash });
    const plain = decryptFile(k, ct);
    expect(sha256Hex(plain)).toBe(sha256Hex(bundle));
  });
});

import { execFileSync } from 'node:child_process';
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
  hpkeSuite,
  parseWrappedKey,
  randomKey,
  sha256Hex,
  unwrapKey,
  UPLOAD_KEYWRAP_INFO,
  wrapKey,
  wrappedKeyHash,
  WRAPPED_KEY_LEN,
  x25519PublicKey,
  x25519SharedSecret,
  type Hex,
} from '../src/index.ts';

const enc = new TextEncoder();
const h = (x: string) => hexToBytes(`0x${x}` as Hex);

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

  it('interoperates with WebCrypto AES-256-GCM (both directions)', async () => {
    const blob = encryptFile(key, pt);
    const ck = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(6, 18) }, ck, blob.subarray(18));
    expect(new Uint8Array(out)).toEqual(pt);

    const n2 = nodeCrypto.randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: n2 }, ck, pt));
    expect(decryptFile(key, new Uint8Array(Buffer.concat([Buffer.from('EMENC1'), n2, ct])))).toEqual(pt);
  });
});

// DER wrappers for raw X25519 keys (RFC 8410)
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const nodePriv = (sk: Uint8Array) => nodeCrypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, sk]), format: 'der', type: 'pkcs8' });
const nodePub = (pk: Uint8Array) => nodeCrypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, pk]), format: 'der', type: 'spki' });

/**
 * RFC 9180 test vector for exactly our suite: mode_base, DHKEM(X25519, HKDF-SHA256) 0x0020,
 * HKDF-SHA256 0x0001, AES-256-GCM 0x0002, first encryption (seq 0). Source: the CFRG
 * test-vectors.json published with RFC 9180 (github.com/cfrg/draft-irtf-cfrg-hpke).
 */
const RFC9180 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  skEm: '179d4b53b6365c45b600c4163b61d95cbc2f4d9e36f1695558dce265ab8bab11',
  pkEm: '6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256',
  skRm: '497b4502664cfea5d5af0b39934dac72242a74f8480451e1aee7d6a53320333d',
  pkRm: '430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c',
  enc: '6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256',
  aad: '436f756e742d30',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  ct: 'e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a',
};

// Second, independent HPKE implementation (Python pyhpke). Point HPKE_PYTHON at an interpreter
// with `pip install pyhpke`; skipped when unavailable.
const PY = process.env.HPKE_PYTHON ?? 'python3';
const hasPyhpke = (() => {
  try {
    execFileSync(PY, ['-c', 'import pyhpke'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const PYHPKE = `import sys, json
from pyhpke import AEADId, CipherSuite, KDFId, KEMId
s = CipherSuite.new(KEMId.DHKEM_X25519_HKDF_SHA256, KDFId.HKDF_SHA256, AEADId.AES256_GCM)
a = json.loads(sys.argv[1])
if a["op"] == "open":
    sk = s.kem.deserialize_private_key(bytes.fromhex(a["sk"]))
    r = s.create_recipient_context(bytes.fromhex(a["enc"]), sk, info=a["info"].encode())
    print(r.open(bytes.fromhex(a["ct"]), aad=bytes.fromhex(a["aad"])).hex())
else:
    pk = s.kem.deserialize_public_key(bytes.fromhex(a["pk"]))
    enc, snd = s.create_sender_context(pk, info=a["info"].encode())
    print(json.dumps({"enc": enc.hex(), "ct": snd.seal(bytes.fromhex(a["pt"]), aad=bytes.fromhex(a["aad"])).hex()}))
`;
const py = (args: Record<string, string>) => execFileSync(PY, ['-c', PYHPKE, JSON.stringify(args)], { encoding: 'utf8' }).trim();

describe('EMKW2 (HPKE RFC 9180 key wrap, @hpke/core)', () => {
  const buyer = generateX25519KeyPair();
  const kBundle = randomKey();
  const wrapperHash = sha256Hex('{"type":"envmarket.delivery.v1"}');

  it('RFC 9180 test vector (X25519 / HKDF-SHA256 / AES-256-GCM, base mode) through our suite', async () => {
    const s = hpkeSuite();
    expect(x25519PublicKey(`0x${RFC9180.skRm}`)).toBe(`0x${RFC9180.pkRm}`);
    const ekm = { privateKey: await s.kem.deserializePrivateKey(h(RFC9180.skEm)), publicKey: await s.kem.deserializePublicKey(h(RFC9180.pkEm)) };
    const sealed = await s.seal({ recipientPublicKey: await s.kem.deserializePublicKey(h(RFC9180.pkRm)), info: h(RFC9180.info), ekm }, h(RFC9180.pt), h(RFC9180.aad));
    expect(bytesToHex(new Uint8Array(sealed.enc))).toBe(`0x${RFC9180.enc}`);
    expect(bytesToHex(new Uint8Array(sealed.ct))).toBe(`0x${RFC9180.ct}`);
    const pt = await s.open({ recipientKey: await s.kem.deserializePrivateKey(h(RFC9180.skRm)), enc: h(RFC9180.enc), info: h(RFC9180.info) }, h(RFC9180.ct), h(RFC9180.aad));
    expect(new Uint8Array(pt)).toEqual(h(RFC9180.pt));
  });

  it('keypair public key derivation', () => {
    expect(x25519PublicKey(buyer.secretKey)).toBe(buyer.publicKey);
    expect(buyer.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('round trips; layout "EMKW2" ‖ enc(32) ‖ ct(48) = 85 bytes', async () => {
    const blob = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    expect(blob.length).toBe(WRAPPED_KEY_LEN);
    expect(WRAPPED_KEY_LEN).toBe(85);
    expect(Buffer.from(blob.subarray(0, 5)).toString()).toBe('EMKW2');
    expect(parseWrappedKey(blob).ciphertext.length).toBe(48);
    expect(await unwrapKey({ blob, recipientSecretKey: buyer.secretKey, wrapperHash })).toEqual(kBundle);
    expect(wrappedKeyHash(blob)).toBe(sha256Hex(blob));
  });

  it('fails with the wrong recipient key, wrong wrapperHash (aad), wrong info, or tampering', async () => {
    const blob = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    const other = generateX25519KeyPair();
    await expect(unwrapKey({ blob, recipientSecretKey: other.secretKey, wrapperHash })).rejects.toThrow(/authentication/);
    await expect(unwrapKey({ blob, recipientSecretKey: buyer.secretKey, wrapperHash: sha256Hex('other wrapper') })).rejects.toThrow(/authentication/);
    await expect(unwrapKey({ blob, recipientSecretKey: buyer.secretKey, wrapperHash, info: UPLOAD_KEYWRAP_INFO })).rejects.toThrow(/authentication/);
    for (const pos of [0, 5, 5 + 31, 5 + 32, blob.length - 1]) {
      const t = new Uint8Array(blob);
      t[pos]! ^= 0x80;
      await expect(unwrapKey({ blob: t, recipientSecretKey: buyer.secretKey, wrapperHash })).rejects.toThrow();
    }
  });

  it('rejects low-order recipient keys', async () => {
    await expect(wrapKey({ key: kBundle, recipientPublicKey: ('0x' + '00'.repeat(32)) as Hex, wrapperHash })).rejects.toThrow(/X25519/);
    await expect(wrapKey({ key: kBundle, recipientPublicKey: ('0x01' + '00'.repeat(31)) as Hex, wrapperHash })).rejects.toThrow(/X25519/);
  });

  it('deterministic given the ephemeral key (relay re-derivation); legacy `nonce` is ignored', async () => {
    const eph = generateX25519KeyPair().secretKey;
    const a = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash, ephemeralSecretKey: eph, nonce: new Uint8Array(12) });
    const b = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash, ephemeralSecretKey: eph, nonce: new Uint8Array(12).fill(7) });
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(bytesToHex(parseWrappedKey(a).enc)).toBe(x25519PublicKey(eph));
  });

  it.skipIf(!hasPyhpke)('interoperates with pyhpke (independent Python implementation), both directions', async () => {
    const blob = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    const { enc: e, ciphertext } = parseWrappedKey(blob);
    const opened = py({ op: 'open', sk: buyer.secretKey.slice(2), enc: Buffer.from(e).toString('hex'), ct: Buffer.from(ciphertext).toString('hex'), aad: wrapperHash.slice(2), info: 'envmarket.keywrap.v1' });
    expect(`0x${opened}`).toBe(bytesToHex(kBundle));

    const sealed = JSON.parse(py({ op: 'seal', pk: buyer.publicKey.slice(2), pt: bytesToHex(kBundle).slice(2), aad: wrapperHash.slice(2), info: 'envmarket.keywrap.v1' })) as { enc: string; ct: string };
    const pyBlob = new Uint8Array(Buffer.concat([Buffer.from('EMKW2'), Buffer.from(sealed.enc, 'hex'), Buffer.from(sealed.ct, 'hex')]));
    expect(await unwrapKey({ blob: pyBlob, recipientSecretKey: buyer.secretKey, wrapperHash })).toEqual(kBundle);
  });

  it('X25519 agrees with node:crypto (OpenSSL): public key and DH', async () => {
    const blob = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    const { enc: e } = parseWrappedKey(blob);
    const shared = nodeCrypto.diffieHellman({ privateKey: nodePriv(hexToBytes(buyer.secretKey)), publicKey: nodePub(e) });
    expect(new Uint8Array(shared)).toEqual(x25519SharedSecret(buyer.secretKey, e));
    const pubDer = nodeCrypto.createPublicKey(nodePriv(hexToBytes(buyer.secretKey))).export({ format: 'der', type: 'spki' });
    expect(bytesToHex(new Uint8Array(pubDer.subarray(12)))).toBe(buyer.publicKey);
  });
});

describe('end-to-end delivery', () => {
  it('seller encrypts, relay wraps to buyer with wrapperHash, buyer decrypts', async () => {
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
    const wk = await wrapKey({ key: kBundle, recipientPublicKey: buyer.publicKey, wrapperHash });
    // buyer side: verify the wrapper, derive the key, decrypt, check bundleHash
    expect(sha256Hex(json)).toBe(wrapperHash);
    const k = await unwrapKey({ blob: wk, recipientSecretKey: buyer.secretKey, wrapperHash });
    const plain = decryptFile(k, ct);
    expect(sha256Hex(plain)).toBe(sha256Hex(bundle));
  });
});

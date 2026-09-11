import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { PurchaseState, buildDeliveryWrapper, generateX25519KeyPair, sha256Hex, wrapKey } from '@envmarket/shared';
import { packageEnvironment, readKeys } from '../src/seller/package.ts';
import { DeliveryVerificationError, verifyDelivery, type DeliveryInputs } from '../src/buyer/verify.ts';
import { makeWorkspace, tmpDir } from './fixture.ts';

const MARKET = '0x1111111111111111111111111111111111111111' as Address;
const BUYER = '0x2222222222222222222222222222222222222222' as Address;
const RELAY = '0x3333333333333333333333333333333333333333' as Address;

function scenario(extraFiles?: Record<string, string>) {
  const r = packageEnvironment({ workspace: makeWorkspace({ extraFiles }), outDir: path.join(tmpDir(), 'v') });
  const keys = readKeys(r.outDir);
  const ciphertext = new Uint8Array(fs.readFileSync(path.join(r.outDir, 'bundle.enc')));
  const v = r.listing.versionInput;
  const buyerKeys = generateX25519KeyPair();
  const w = buildDeliveryWrapper({
    purchaseId: 5n,
    chainId: 31337,
    market: MARKET,
    buyer: BUYER,
    buyerEncPubKey: buyerKeys.publicKey,
    versionId: 2n,
    bundleHash: v.bundleHash,
    ciphertextHash: v.ciphertextHash,
    relay: RELAY,
  });
  const wrappedKey = wrapKey({ key: keys.bundleKey, recipientPublicKey: buyerKeys.publicKey, wrapperHash: w.wrapperHash });
  const inputs: DeliveryInputs = {
    chainId: 31337,
    market: MARKET,
    purchaseId: 5n,
    buyer: BUYER,
    buyerEncSk: buyerKeys.secretKey,
    purchase: {
      versionId: 2n,
      buyer: BUYER,
      state: PurchaseState.Delivered,
      buyerEncPubKey: buyerKeys.publicKey,
      ciphertextHash: v.ciphertextHash,
      wrappedKeyHash: sha256Hex(wrappedKey),
      wrapperHash: w.wrapperHash,
      relay: RELAY,
    },
    deliveredEvent: { ciphertextHash: v.ciphertextHash, wrappedKeyHash: sha256Hex(wrappedKey), wrapperHash: w.wrapperHash },
    version: {
      bundleHash: v.bundleHash,
      ciphertextHash: v.ciphertextHash,
      manifestHash: v.manifestHash,
      imageDigest: v.imageDigest,
      taskRoot: v.taskRoot,
      auditRoot: v.auditRoot,
      taskCount: v.taskCount,
      auditTaskCount: v.auditTaskCount,
    },
    wrapperJson: w.json,
    wrappedKey,
    ciphertext,
  };
  return { inputs, r, buyerKeys, w };
}

function failsAt(inputs: DeliveryInputs, check: string) {
  try {
    verifyDelivery(inputs);
  } catch (e) {
    expect(e).toBeInstanceOf(DeliveryVerificationError);
    expect((e as DeliveryVerificationError).check).toBe(check);
    return;
  }
  throw new Error(`expected verification to fail at ${check}`);
}

const flip = (b: Uint8Array, i: number) => {
  const c = new Uint8Array(b);
  c[i] = c[i]! ^ 0x01;
  return c;
};

describe('buyer receive verification', () => {
  it('accepts an honest delivery and yields the committed bundle', () => {
    const { inputs, r } = scenario();
    const out = verifyDelivery(inputs);
    expect(sha256Hex(out.bundle)).toBe(r.bundleHash);
    expect(out.taskIds).toEqual(['T1', 'T2', 'T3']);
    expect(out.checks.map((c) => c.name)).toContain('no-private-material');
  });

  it('rejects a tampered ciphertext', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, ciphertext: flip(inputs.ciphertext, 100) }, 'ciphertextHash');
  });

  it('rejects a tampered wrapped key', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, wrappedKey: flip(inputs.wrappedKey, 60) }, 'wrappedKeyHash');
  });

  it('rejects a modified wrapper (e.g. re-addressed to another buyer)', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, wrapperJson: inputs.wrapperJson.replace(BUYER.toLowerCase(), '0x4444444444444444444444444444444444444444') }, 'wrapperHash');
  });

  it('rejects a wrapper whose hash matches on-chain but binds the wrong purchase', () => {
    const { inputs, buyerKeys } = scenario();
    const w = buildDeliveryWrapper({
      purchaseId: 6n,
      chainId: 31337,
      market: MARKET,
      buyer: BUYER,
      buyerEncPubKey: buyerKeys.publicKey,
      versionId: 2n,
      bundleHash: inputs.version.bundleHash,
      ciphertextHash: inputs.version.ciphertextHash,
      relay: RELAY,
    });
    failsAt(
      {
        ...inputs,
        wrapperJson: w.json,
        purchase: { ...inputs.purchase, wrapperHash: w.wrapperHash },
        deliveredEvent: { ...inputs.deliveredEvent!, wrapperHash: w.wrapperHash },
      },
      'wrapper.binding',
    );
  });

  it('rejects a key wrapped under a different wrapperHash (relay/seller mismatch)', () => {
    const { inputs, r, buyerKeys } = scenario();
    const keys = readKeys(r.outDir);
    const bad = wrapKey({ key: keys.bundleKey, recipientPublicKey: buyerKeys.publicKey, wrapperHash: `0x${'77'.repeat(32)}` as Hex });
    failsAt({ ...inputs, wrappedKey: bad, purchase: { ...inputs.purchase, wrappedKeyHash: sha256Hex(bad) }, deliveredEvent: undefined }, 'unwrapKey');
  });

  it('rejects the wrong buyer secret key', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, buyerEncSk: generateX25519KeyPair().secretKey }, 'buyerEncPubKey');
  });

  it('rejects a plaintext that does not match the listed bundleHash', () => {
    const { inputs } = scenario();
    const other = scenario();
    // the relay delivers a validly-encrypted but different (other version's) bundle key+ciphertext
    failsAt({ ...inputs, version: { ...inputs.version, bundleHash: other.inputs.version.bundleHash } }, 'wrapper.binding');
  });

  it('rejects when the on-chain Delivered event disagrees with storage', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, deliveredEvent: { ...inputs.deliveredEvent!, wrapperHash: `0x${'55'.repeat(32)}` as Hex } }, 'delivered.event');
  });

  it('rejects an undelivered purchase', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, purchase: { ...inputs.purchase, state: PurchaseState.Funded } }, 'purchase.state');
  });

  it('rejects a manifest that does not match the on-chain commitments', () => {
    const { inputs } = scenario();
    failsAt({ ...inputs, version: { ...inputs.version, taskRoot: `0x${'99'.repeat(32)}` as Hex } }, 'manifest.commitments');
  });

  it('detects audit material a seller slipped into the purchased payload', () => {
    const { inputs } = scenario({ 'src/audit/A9.json': '{"taskId":"A9"}' });
    failsAt(inputs, 'no-private-material');
  });
});

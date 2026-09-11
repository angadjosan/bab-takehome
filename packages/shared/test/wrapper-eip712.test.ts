import { execFileSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildDeliveryWrapper,
  envMarketDomain,
  envMarketTypedDataHash,
  envMarketTypes,
  evidenceAuthMessage,
  parseDeliveryWrapper,
  recoverEnvMarketSigner,
  sha256Hex,
  signDeliveryReceipt,
  signEvidenceAuth,
  signMechanicalFinding,
  signPreviewReport,
  verifyEnvMarketSignature,
  verifyEvidenceAuth,
  wrapperHashOf,
} from '../src/index.ts';
import { ANVIL_ADDR0, ANVIL_PK0, CAST, hasCast } from './helpers.ts';

const MARKET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

describe('delivery wrapper', () => {
  const input = {
    purchaseId: 12n,
    chainId: 8453,
    market: MARKET,
    buyer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    buyerEncPubKey: ('0x' + 'AB'.repeat(32)) as Hex,
    versionId: 4,
    bundleHash: sha256Hex('bundle'),
    ciphertextHash: sha256Hex('ct'),
    issuedAt: 1_789_000_000,
    relay: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  } as const;

  it('canonical JSON with sorted keys, lowercase hex, decimal-string ids', () => {
    const { json, wrapperHash, wrapper } = buildDeliveryWrapper(input);
    expect(json).toBe(
      `{"bundleHash":"${sha256Hex('bundle')}","buyer":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","buyerEncPubKey":"0x` +
        'ab'.repeat(32) +
        `","chainId":8453,"ciphertextHash":"${sha256Hex('ct')}","issuedAt":1789000000,` +
        `"market":"${MARKET.toLowerCase()}","purchaseId":"12","relay":"0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc","type":"envmarket.delivery.v1","versionId":"4"}`,
    );
    expect(wrapperHash).toBe(sha256Hex(json));
    expect(wrapperHashOf(wrapper)).toBe(wrapperHash);
    expect(parseDeliveryWrapper(json).wrapperHash).toBe(wrapperHash);
  });

  it('rejects non-canonical or incomplete wrappers', () => {
    const { wrapper } = buildDeliveryWrapper(input);
    expect(() => parseDeliveryWrapper(JSON.stringify(wrapper, null, 1))).toThrow(/canonical/);
    const { relay: _r, ...rest } = wrapper;
    expect(() => parseDeliveryWrapper(JSON.stringify(rest))).toThrow();
  });
});

describe('EIP-712', () => {
  const account = privateKeyToAccount(ANVIL_PK0);
  const domain = envMarketDomain(8453, MARKET);

  const preview = { versionId: 1n, bundleHash: sha256Hex('b'), reportHash: sha256Hex('r') };
  const receipt = {
    purchaseId: 2n,
    buyerEncPubKey: sha256Hex('pk'),
    ciphertextHash: sha256Hex('ct'),
    wrappedKeyHash: sha256Hex('wk'),
    wrapperHash: sha256Hex('w'),
  };
  const finding = { disputeId: 3n, upheld: true, confirmedMask: 0b101n, findingsHash: sha256Hex('f') };

  it('sign / recover / verify all three types', async () => {
    const s1 = await signPreviewReport(account, domain, preview);
    const s2 = await signDeliveryReceipt(account, domain, receipt);
    const s3 = await signMechanicalFinding(account, domain, finding);
    expect(await recoverEnvMarketSigner(domain, 'PreviewReport', preview, s1)).toBe(ANVIL_ADDR0);
    expect(await recoverEnvMarketSigner(domain, 'DeliveryReceipt', receipt, s2)).toBe(ANVIL_ADDR0);
    expect(await recoverEnvMarketSigner(domain, 'MechanicalFinding', finding, s3)).toBe(ANVIL_ADDR0);
    expect(await verifyEnvMarketSignature(domain, 'PreviewReport', preview, s1, ANVIL_ADDR0)).toBe(true);
  });

  it('tampered message, other chain, or other contract does not verify', async () => {
    const sig = await signPreviewReport(account, domain, preview);
    expect(await verifyEnvMarketSignature(domain, 'PreviewReport', { ...preview, versionId: 2n }, sig, ANVIL_ADDR0)).toBe(false);
    expect(await verifyEnvMarketSignature(envMarketDomain(31337, MARKET), 'PreviewReport', preview, sig, ANVIL_ADDR0)).toBe(false);
    expect(await verifyEnvMarketSignature(envMarketDomain(8453, ANVIL_ADDR0), 'PreviewReport', preview, sig, ANVIL_ADDR0)).toBe(false);
    expect(await verifyEnvMarketSignature(domain, 'PreviewReport', preview, '0x1234', ANVIL_ADDR0)).toBe(false);
  });

  it('digest equals viem hashTypedData with explicit types', () => {
    expect(envMarketTypedDataHash(domain, 'MechanicalFinding', finding)).toBe(
      hashTypedData({ domain, types: { MechanicalFinding: envMarketTypes.MechanicalFinding }, primaryType: 'MechanicalFinding', message: finding }),
    );
  });

  it.skipIf(!hasCast)('signature matches `cast wallet sign --data` (independent EIP-712 implementation)', async () => {
    const typed = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        DeliveryReceipt: envMarketTypes.DeliveryReceipt,
      },
      primaryType: 'DeliveryReceipt',
      domain,
      message: { ...receipt, purchaseId: receipt.purchaseId.toString() },
    };
    const castSig = execFileSync(CAST, ['wallet', 'sign', '--private-key', ANVIL_PK0, '--data', JSON.stringify(typed)], { encoding: 'utf8' }).trim();
    expect(await signDeliveryReceipt(account, domain, receipt)).toBe(castSig);
  });
});

describe('juror evidence auth (EIP-191)', () => {
  it('signs and verifies; rejects expired / wrong juror', async () => {
    const account = privateKeyToAccount(ANVIL_PK0);
    const message = evidenceAuthMessage({ chainId: 8453, market: MARKET, disputeId: 5n, juror: account.address, nonce: 'n1', expiresAt: 2_000_000_000 });
    const signature = await signEvidenceAuth(account, message);
    expect(await verifyEvidenceAuth({ message, signature, juror: account.address, nowSec: 1_900_000_000 })).toBe(true);
    expect(await verifyEvidenceAuth({ message, signature, juror: account.address, nowSec: 2_000_000_001 })).toBe(false);
    expect(await verifyEvidenceAuth({ message, signature, juror: MARKET, nowSec: 1_900_000_000 })).toBe(false);
  });
});

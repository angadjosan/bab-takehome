import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@envmarket/shared';
import { entrySigner, importSealed, previewCacheKey, sealEntry, signEntry, type PreviewCacheEntry, type PreviewCacheKeyInput } from '../src/cache.ts';
import type { Ctx } from '../src/context.ts';
import { ceilToCent, feeUsdcBaseUnits, quotePreviewCost, tokenBudgetFor, usageCostUsd } from '../src/cost.ts';
import { keysFromPrivateKey } from '../src/keys.ts';
import { PrivateStore } from '../src/store.ts';

const PANEL = ['accounts/fireworks/models/glm-5p3', 'accounts/fireworks/models/kimi-k3', 'accounts/fireworks/models/qwen3p8-max'];
const VALIDATOR = 'accounts/fireworks/models/deepseek-v4-pro-0813';

describe('preview cost (docs/PREVIEW_COST.md)', () => {
  it('reproduces the py-repair-kit quote: 7 tasks x 3 models + validator', () => {
    const q = quotePreviewCost({ models: PANEL, nTasks: 7, validatorModel: VALIDATOR, validatorInputChars: 135_934 });
    expect(q.episodeCostUsd).toBeCloseTo(1.468, 3);
    expect(q.validatorCostUsd).toBeCloseTo(0.065, 3);
    expect(q.quoteUsd).toBe(2.27);
    expect(q.worstCaseUsd).toBeGreaterThan(8.1);
    expect(q.worstCaseUsd).toBeLessThan(8.25);
    expect(feeUsdcBaseUnits(q.quoteUsd, 0n)).toBe(2_270_000n);
  });
  it('humanevalfix-8 quote (10 tasks)', () => {
    expect(quotePreviewCost({ models: PANEL, nTasks: 10, validatorModel: VALIDATOR, validatorInputChars: 142_922 }).quoteUsd).toBe(3.22);
  });
  it('a cached preview costs zero inference and pays only the on-chain minimum fee', () => {
    const q = quotePreviewCost({ models: [], nTasks: 0, validatorModel: null });
    expect(q.quoteUsd).toBe(0);
    expect(feeUsdcBaseUnits(q.quoteUsd, 50_000n)).toBe(50_000n);
  });
  it('token budgets and actual cost', () => {
    expect(tokenBudgetFor(PANEL[0]!)).toEqual({ in: 135000, out: 21600 });
    expect(tokenBudgetFor('gpt-oss:20b')).toBeNull(); // local model: nothing billed
    // GLM T3 validation run: 22,499 prompt (17,150 cached) / 4,366 completion → $0.0312 billed
    expect(usageCostUsd(PANEL[0]!, { promptTokens: 22_499, completionTokens: 4_366, cachedPromptTokens: 17_150 })).toBeCloseTo(0.0312, 3);
    expect(usageCostUsd(PANEL[0]!, { promptTokens: 22_499, completionTokens: 4_366 })).toBeCloseTo(0.0507, 3);
    expect(ceilToCent(2.2601)).toBe(2.27);
    expect(ceilToCent(2.27)).toBe(2.27);
  });
});

function ctxFor(pk: `0x${string}`, trusted = ''): Ctx {
  const keys = keysFromPrivateKey(pk);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tee-cache-'));
  return { keys, priv: new PrivateStore(dir, keys.storageKey), cfg: { rawEnv: { PREVIEW_CACHE_TRUSTED_SIGNERS: trusted } } } as unknown as Ctx;
}

const keyInput: PreviewCacheKeyInput = {
  bundleHash: sha256Hex('bundle'),
  auditRoot: sha256Hex('audit'),
  protocolId: 'envmarket.preview.v1',
  harnessDigest: sha256Hex('h'),
  promptDigest: sha256Hex('p'),
  validatorPromptHash: sha256Hex('v'),
  panel: PANEL.map((id, i) => ({ requested: ['GLM 5.3', 'Kimi K3', 'Qwen 3.8'][i]!, resolved: id, status: 'run' })),
  validatorModel: VALIDATOR,
};

function entry(): PreviewCacheEntry {
  return {
    type: 'envmarket.preview-cache.v1',
    key: previewCacheKey(keyInput),
    keyInput,
    environmentVersion: 'py-repair-kit@1.0.0',
    original: { versionId: '1', chainId: 31337, market: '0x' + '11'.repeat(20), runAt: '2026-09-10T00:00:00.000Z', reportHash: sha256Hex('r'), signer: '', attestationKind: 'none-local-dev', appId: null, sandbox: 'docker' },
    report: {} as PreviewCacheEntry['report'],
    models: {} as PreviewCacheEntry['models'],
    episodes: [],
    validatorPrivate: null,
    spec: {},
    producer: '',
  };
}

describe('preview cache', () => {
  const A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
  it('key is independent of version/market/chain and changes with content or models', () => {
    expect(previewCacheKey(keyInput)).toBe(previewCacheKey({ ...keyInput, bundleHash: keyInput.bundleHash.toUpperCase().replace('0X', '0x') }));
    expect(previewCacheKey({ ...keyInput, bundleHash: sha256Hex('other') })).not.toBe(previewCacheKey(keyInput));
    expect(previewCacheKey({ ...keyInput, validatorModel: 'x' })).not.toBe(previewCacheKey(keyInput));
  });
  it('sealed export imports only from a trusted producer, for the right recipient, untampered', async () => {
    const producer = ctxFor(A);
    const signed = await signEntry(producer, entry());
    expect((await entrySigner(signed))?.toLowerCase()).toBe(producer.keys.account.address.toLowerCase());

    const untrusting = ctxFor(B);
    await expect(importSealed(untrusting, await sealEntry(signed, untrusting.keys.encPublicKey))).rejects.toThrow(/not trusted/);

    const trusting = ctxFor(B, producer.keys.account.address);
    const r = await importSealed(trusting, await sealEntry(signed, trusting.keys.encPublicKey));
    expect(r.key).toBe(signed.key);
    expect(r.replaced).toBe(false);

    await expect(importSealed(trusting, await sealEntry(signed, producer.keys.encPublicKey))).rejects.toThrow(/different service key/);
    const tampered = { ...signed, environmentVersion: 'evil' };
    await expect(importSealed(trusting, await sealEntry(tampered, trusting.keys.encPublicKey))).rejects.toThrow(/signature invalid/);
    const rekeyed = { ...signed, keyInput: { ...keyInput, bundleHash: sha256Hex('x') } };
    await expect(importSealed(trusting, await sealEntry(rekeyed, trusting.keys.encPublicKey))).rejects.toThrow(/key does not match/);
  });
});

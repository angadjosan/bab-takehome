import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceConfig } from '../src/config.ts';
import { harnessEnv, loadHarness, locateHarness, missingEpisode, sandboxArgs, toEpisodeResult, type HarnessRecord } from '../src/harnessRunner.ts';
import { NETDENY, type SandboxInfo } from '../src/sandbox.ts';

const REPO = path.resolve(__dirname, '..', '..', '..');
const cfg = { rawEnv: {}, repoRoot: REPO, preview: { actionBudget: 12, episodeTimeSec: 300 } } as unknown as ServiceConfig;

const rec: HarnessRecord = {
  type: 'episode',
  episodeId: 'py-repair-kit:purchased:T1:accounts/fireworks/models/kimi-k3',
  environmentId: 'py-repair-kit',
  taskId: 'T1',
  split: 'purchased',
  requestedModel: 'accounts/fireworks/models/kimi-k3',
  servedModels: ['accounts/fireworks/models/kimi-k3'],
  status: 'succeeded',
  solved: true,
  score: 1,
  termination: 'submitted',
  stopCondition: 'has_final_env_response',
  actions: [{ type: 'read_file', path: 'ledgerlite/lru.py', ok: true }],
  llmCalls: 4,
  usage: { prompt: 10_000, completion: 1_000 },
  seedSent: true,
  startedAt: '2026-09-11T00:00:00Z',
  finishedAt: '2026-09-11T00:00:20Z',
  grade: { score: 1, success: true, termination: 'submitted', passed: 12, failed: 0, collected: 12, allHiddenTestsPassed: true, timedOut: false, editedFiles: ['ledgerlite/lru.py'], gradedTreeDigest: '0xabc' },
  finalFiles: { 'ledgerlite/lru.py': 'x = 1\n' },
  transcriptHash: '0xdef',
  error: null,
};

describe('harness client', () => {
  it('maps a harness episode record onto the stored EpisodeResult shape', () => {
    const e = toEpisodeResult(rec, { jobId: 'v1.m1.j0', requested: 'Kimi K3', provider: 'fireworks', set: 'purchased' });
    expect(e).toMatchObject({ jobId: 'v1.m1.j0', requested: 'Kimi K3', model: rec.requestedModel, set: 'purchased', status: 'succeeded', solved: true, termination: 'submitted', llmCalls: 4, harnessEpisodeId: rec.episodeId });
    expect(e.grade).toMatchObject({ passed: 12, gradedTreeDigest: '0xabc', editedFiles: ['ledgerlite/lru.py'] });
    expect(e.usage.promptTokens).toBe(10_000);
    expect(e.usage.costUsd).toBeCloseTo((10_000 * 3 + 1_000 * 15) / 1e6, 6); // kimi-k3 list price
    expect(e.finalFiles['ledgerlite/lru.py']).toBe('x = 1\n');
  });
  it('an infra failure is never solved; missing episodes are synthesized as infra failures', () => {
    expect(toEpisodeResult({ ...rec, status: 'infra_failure', solved: true }, { jobId: 'j', requested: 'r', provider: 'p', set: 'audit' }).solved).toBe(false);
    const m = missingEpisode({ jobId: 'j', requested: 'GLM 5.3', provider: 'fireworks', set: 'audit' }, 'accounts/fireworks/models/glm-5p3', 'A1', 'harness exited 1');
    expect(m).toMatchObject({ status: 'infra_failure', solved: false, taskId: 'A1', set: 'audit' });
  });
  it('never hands key material to the harness process', () => {
    process.env.MNEMONIC = 'secret words';
    process.env.SELLER_PK = '0x1';
    process.env.KMS_PUBLIC_KEY = 'k';
    const env = harnessEnv(cfg, { HARNESS_LLM_API_KEY: 'fw' });
    expect(env.MNEMONIC).toBeUndefined();
    expect(env.SELLER_PK).toBeUndefined();
    expect(env.KMS_PUBLIC_KEY).toBeUndefined();
    expect(env.HARNESS_LLM_API_KEY).toBe('fw');
    delete process.env.MNEMONIC;
    delete process.env.SELLER_PK;
    delete process.env.KMS_PUBLIC_KEY;
  });
  it('sandbox flags follow the TEE sandbox', () => {
    expect(sandboxArgs({ kind: 'docker', image: 'img@sha256:1', unshareNet: false, seccompNetDeny: false, description: '' } as SandboxInfo)).toEqual(['--sandbox', 'docker', '--image', 'img@sha256:1']);
    expect(sandboxArgs({ kind: 'linux-root', image: null, unshareNet: false, seccompNetDeny: true, description: '' } as SandboxInfo)).toEqual(['--sandbox', 'unshare', '--netdeny', NETDENY, '--grader-python', 'python3']);
    expect(() => sandboxArgs({ kind: 'unavailable', image: null, unshareNet: false, seccompNetDeny: false, description: 'x' } as SandboxInfo)).toThrow();
  });
  const loc = locateHarness(cfg);
  it.skipIf(!loc || !fs.existsSync(loc.python))('binds the real harness: --digest returns harness/prompt digests and the protocol', async () => {
    const h = await loadHarness(cfg);
    expect(h?.digest.type).toBe('digest');
    expect(h?.digest.harnessDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h?.digest.promptDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect((h?.digest.protocol as { actionBudget: number }).actionBudget).toBe(12);
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { chooseModel, familiesFor, PINNED_FIREWORKS_MODELS, providerFromEnv, resolveJurorLlm, sharesPanelFamily } from '../src/llm.ts';

const M = (id: string, created?: number) => ({ id: `accounts/fireworks/models/${id}`, created });
const models = [
  M('deepseek-v3p1', 100),
  M('deepseek-v4p1-flash', 200),
  M('deepseek-v4p2-vl', 300),
  M('llama4-maverick-instruct-basic', 150),
  M('llama-guard-4-12b', 400),
  M('gpt-oss-20b', 90),
  M('gpt-oss-120b', 95),
  M('glm-5p2', 500),
  M('glm-5p3', 999),
  M('kimi-k3', 999),
  M('qwen3p8-max', 999),
];

describe('juror model selection', () => {
  it('uses the pinned Fireworks ids when listed', async () => {
    for (const n of [1, 2, 3]) {
      const l = await resolveJurorLlm(n, { FIREWORKS_API_KEY: 'k' }, { models });
      expect(l.model).toBe(PINNED_FIREWORKS_MODELS[n]);
      expect(l.requested).toBe(`pinned:${PINNED_FIREWORKS_MODELS[n]}`);
    }
    expect(new Set(Object.values(PINNED_FIREWORKS_MODELS)).size).toBe(3);
  });

  it('falls back to the newest model of the juror family when the pin is missing', async () => {
    const without = models.filter((m) => !m.id.endsWith('glm-5p2'));
    const l = await resolveJurorLlm(3, { FIREWORKS_API_KEY: 'k' }, { models: without });
    expect(l).toMatchObject({ model: 'accounts/fireworks/models/glm-5p3', requested: 'family:glm' });
  });

  it('fallback families are distinct and skip non-chat variants', () => {
    expect(chooseModel(models, familiesFor(1, {}))).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
    expect(chooseModel(models, familiesFor(2, {}))).toBe('accounts/fireworks/models/gpt-oss-120b');
    expect(chooseModel(models, ['llama'])).toBe('accounts/fireworks/models/llama4-maverick-instruct-basic');
  });

  it('honours JUROR{n}_FAMILY priority order (and skips the pin)', async () => {
    expect(chooseModel(models, familiesFor(1, { JUROR1_FAMILY: 'mistral, llama' }))).toBe('accounts/fireworks/models/llama4-maverick-instruct-basic');
    const l = await resolveJurorLlm(1, { FIREWORKS_API_KEY: 'k', JUROR1_FAMILY: 'gpt-oss' }, { models });
    expect(l.model).toBe('accounts/fireworks/models/gpt-oss-120b');
  });

  it('JUROR{n}_MODEL overrides everything', async () => {
    const l = await resolveJurorLlm(2, { FIREWORKS_API_KEY: 'k', JUROR2_MODEL: 'accounts/fireworks/models/x' }, { models });
    expect(l).toMatchObject({ kind: 'fireworks', model: 'accounts/fireworks/models/x', requested: 'env:JUROR2_MODEL' });
  });

  it('flags models that share a base family with the reference panel', () => {
    expect(sharesPanelFamily('accounts/fireworks/models/glm-5p2')).toBe(true);
    expect(sharesPanelFamily('accounts/fireworks/models/gpt-oss-120b')).toBe(false);
    expect(sharesPanelFamily('gemma4:latest')).toBe(false);
  });
});

describe('provider selection', () => {
  it('defaults to Fireworks when a key is present', () => {
    expect(providerFromEnv(1, { FIREWORKS_API_KEY: 'k' })).toEqual({ kind: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k' });
  });
  it('falls back to local Ollama with no key and no base URL', () => {
    expect(providerFromEnv(1, {})).toEqual({ kind: 'ollama-local', baseUrl: 'http://localhost:11434/v1' });
  });
  it('explicit base URL wins, per-juror first', () => {
    expect(providerFromEnv(2, { FIREWORKS_API_KEY: 'k', LLM_BASE_URL: 'http://localhost:11434/v1/' }).kind).toBe('ollama-local');
    expect(providerFromEnv(2, { LLM_BASE_URL: 'http://a/v1', LLM_BASE_URL_JUROR2: 'https://api.fireworks.ai/inference/v1', FIREWORKS_API_KEY: 'k' })).toEqual({
      kind: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      apiKey: 'k',
    });
  });
});

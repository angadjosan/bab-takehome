import { describe, expect, it } from 'vitest';
import { chooseModel, familiesFor, providerFromEnv, resolveJurorLlm } from '../src/llm.ts';

const M = (id: string, created?: number) => ({ id: `accounts/fireworks/models/${id}`, created });
const models = [
  M('deepseek-v3p1', 100),
  M('deepseek-v3p2', 200),
  M('deepseek-v3p2-vl', 300),
  M('llama-v3p3-70b-instruct', 50),
  M('llama4-maverick-instruct-basic', 150),
  M('llama-guard-4-12b', 400),
  M('gpt-oss-20b', 90),
  M('gpt-oss-120b', 95),
  M('glm-5p3', 999),
  M('kimi-k3', 999),
  M('qwen3p8-max', 999),
];

describe('juror model selection', () => {
  it('uses three distinct non-panel families, newest per family', () => {
    expect(chooseModel(models, familiesFor(1, {}))).toBe('accounts/fireworks/models/deepseek-v3p2');
    expect(chooseModel(models, familiesFor(2, {}))).toBe('accounts/fireworks/models/llama4-maverick-instruct-basic');
    expect(chooseModel(models, familiesFor(3, {}))).toBe('accounts/fireworks/models/gpt-oss-120b');
  });

  it('never picks reference-panel families even if asked', () => {
    expect(chooseModel(models, ['glm', 'kimi', 'qwen'])).toBeNull();
  });

  it('honours JUROR{n}_FAMILY priority order', () => {
    expect(chooseModel(models, familiesFor(1, { JUROR1_FAMILY: 'mistral, gpt-oss' }))).toBe('accounts/fireworks/models/gpt-oss-120b');
  });

  it('resolves with explicit JUROR{n}_MODEL override', async () => {
    const l = await resolveJurorLlm(2, { FIREWORKS_API_KEY: 'k', JUROR2_MODEL: 'accounts/fireworks/models/x' }, { models });
    expect(l).toMatchObject({ kind: 'fireworks', model: 'accounts/fireworks/models/x', requested: 'env:JUROR2_MODEL' });
  });

  it('resolves from the provider model list', async () => {
    const l = await resolveJurorLlm(3, { FIREWORKS_API_KEY: 'k' }, { models });
    expect(l).toMatchObject({ kind: 'fireworks', model: 'accounts/fireworks/models/gpt-oss-120b', requested: 'family:gpt-oss' });
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

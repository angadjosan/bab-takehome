/**
 * LLM selection for agent-side semantic checks (buyer claims audit).
 *
 * Order: explicit LLM_BASE_URL_BUYER / LLM_BASE_URL (+ LLM_MODEL[_BUYER]) → Fireworks AI
 * (FIREWORKS_API_KEY; model BUYER_LLM_MODEL, default gpt-oss-120b) → local Ollama (local dev
 * fallback; OLLAMA_BASE_URL, OLLAMA_MODEL default gpt-oss:20b). The chosen provider/model is
 * recorded in every finding. No canned answers: if no provider is reachable, semantic checks
 * report status "unverified" with the error.
 */
import { LlmClient, llmConfigFromEnv } from '@envmarket/shared';

export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
export const DEFAULT_FIREWORKS_MODEL = 'accounts/fireworks/models/gpt-oss-120b';
export const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b';

export interface AgentLlm {
  client: LlmClient;
  provider: 'fireworks' | 'ollama-local-dev' | 'custom';
  model: string;
  baseURL: string;
}

export function agentLlm(role = 'buyer', env: Record<string, string | undefined> = process.env): AgentLlm {
  const R = role.toUpperCase();
  const explicitBase = env[`LLM_BASE_URL_${R}`] || env.LLM_BASE_URL;
  if (explicitBase) {
    const cfg = llmConfigFromEnv(role, env);
    const model = cfg.model ?? env[`${R}_LLM_MODEL`];
    if (!model) throw new Error(`LLM_BASE_URL set but no model: set LLM_MODEL_${R} or LLM_MODEL`);
    return { client: new LlmClient({ ...cfg, model, temperature: 0, timeoutMs: 300_000 }), provider: 'custom', model, baseURL: cfg.baseURL };
  }
  if (env.FIREWORKS_API_KEY) {
    const model = env[`${R}_LLM_MODEL`] || DEFAULT_FIREWORKS_MODEL;
    return {
      client: new LlmClient({ baseURL: FIREWORKS_BASE_URL, apiKey: env.FIREWORKS_API_KEY, model, temperature: 0, maxTokens: 4096, timeoutMs: 300_000 }),
      provider: 'fireworks',
      model,
      baseURL: FIREWORKS_BASE_URL,
    };
  }
  const baseURL = (env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const model = env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  return {
    client: new LlmClient({ baseURL, model, temperature: 0, seed: 7, maxTokens: 4096, timeoutMs: 600_000, retries: 1 }),
    provider: 'ollama-local-dev',
    model,
    baseURL,
  };
}

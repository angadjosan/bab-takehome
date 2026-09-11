/**
 * Per-juror inference provider + model selection, on top of @envmarket/shared's LlmClient and
 * resolver (pickNewestModels).
 *
 * Provider precedence (first match wins):
 *   1. LLM_BASE_URL_JUROR{n} | LLM_BASE_URL (+ LLM_API_KEY_JUROR{n} | LLM_API_KEY)
 *   2. FIREWORKS_API_KEY -> Fireworks AI (https://api.fireworks.ai/inference/v1), the spec default
 *   3. nothing configured -> local Ollama at http://localhost:11434/v1 (local dev only; recorded)
 * Model: JUROR{n}_MODEL | LLM_MODEL_JUROR{n} (exact id) overrides; otherwise the newest model of
 * the juror's default family (JUROR{n}_FAMILY to override) from GET <base>/models, or a fixed local
 * model for Ollama. The id the server reports it served is recorded with every decision.
 */
import { FIREWORKS_BASE_URL, isFireworks, LlmClient, OLLAMA_BASE_URL, pickNewestModels, type ProviderModel } from '@envmarket/shared';

export type ProviderKind = 'fireworks' | 'ollama-local' | 'openai-compatible';

export interface ProviderSettings {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

export interface JurorLlm extends ProviderSettings {
  /** What was asked for: "family:deepseek", "env:JUROR1_MODEL", "local-default". */
  requested: string;
  /** Exact model id sent in requests. */
  model: string;
  client: LlmClient;
}

/**
 * Default juror families: three distinct families, none shared with the GLM/Kimi/Qwen reference
 * panel, so jurors do not inherit the preview panel's base-model errors.
 */
export const DEFAULT_FAMILIES: Record<number, string[]> = {
  1: ['deepseek'],
  2: ['llama'],
  3: ['gpt-oss'],
};
/** Local Ollama defaults (models commonly pulled for local dev). */
export const DEFAULT_LOCAL_MODELS: Record<number, string> = {
  1: 'gpt-oss:20b',
  2: 'gemma4:latest',
  3: 'gpt-oss:20b',
};
/** Never used for jurors: non-chat variants and the reference-panel families. */
export const JUROR_MODEL_EXCLUDE = /(guard|vision|embed|rerank|whisper|audio|image|tts|ocr|flux|-vl(-|$)|glm|kimi|qwen)/i;

type Env = Record<string, string | undefined>;
const pick = (env: Env, ...keys: string[]) => {
  for (const k of keys) if (env[k]) return env[k];
  return undefined;
};

export function providerFromEnv(index: number, env: Env): ProviderSettings {
  const base = pick(env, `LLM_BASE_URL_JUROR${index}`, 'LLM_BASE_URL')?.replace(/\/+$/, '');
  if (base) {
    const kind: ProviderKind = isFireworks(base) ? 'fireworks' : /:11434(\/|$)/.test(base) ? 'ollama-local' : 'openai-compatible';
    const apiKey = pick(env, `LLM_API_KEY_JUROR${index}`, 'LLM_API_KEY') ?? (kind === 'fireworks' ? env.FIREWORKS_API_KEY : undefined);
    return { kind, baseUrl: base, apiKey };
  }
  if (env.FIREWORKS_API_KEY) return { kind: 'fireworks', baseUrl: FIREWORKS_BASE_URL, apiKey: env.FIREWORKS_API_KEY };
  return { kind: 'ollama-local', baseUrl: OLLAMA_BASE_URL };
}

export function familiesFor(index: number, env: Env): string[] {
  const o = env[`JUROR${index}_FAMILY`];
  return o ? o.split(',').map((s) => s.trim()).filter(Boolean) : (DEFAULT_FAMILIES[index] ?? DEFAULT_FAMILIES[1]!);
}

/** Pure: first family (in priority order) that has a model, newest within it (shared resolver). */
export function chooseModel(models: ProviderModel[], families: string[]): string | null {
  const picked = pickNewestModels(models, families, { exclude: JUROR_MODEL_EXCLUDE });
  for (const f of families) if (picked[f]) return picked[f]!.id;
  return null;
}

export async function resolveJurorLlm(index: number, env: Env, opts: { models?: ProviderModel[] } = {}): Promise<JurorLlm> {
  const p = providerFromEnv(index, env);
  const client = new LlmClient({ baseURL: p.baseUrl, apiKey: p.apiKey, temperature: 0, seed: 0, maxTokens: 4096, timeoutMs: 300_000, retries: 2 });
  const explicitKey = [`JUROR${index}_MODEL`, `LLM_MODEL_JUROR${index}`].find((k) => env[k]);
  if (explicitKey) {
    const model = env[explicitKey]!;
    return { ...p, requested: `env:${explicitKey}`, model, client: client.with({ model }) };
  }
  if (p.kind === 'ollama-local') {
    const model = DEFAULT_LOCAL_MODELS[index] ?? DEFAULT_LOCAL_MODELS[1]!;
    return { ...p, requested: 'local-default', model, client: client.with({ model }) };
  }
  const families = familiesFor(index, env);
  const models = opts.models ?? (await client.listModels());
  const model = chooseModel(models, families);
  if (!model) throw new Error(`no chat model in families [${families.join(', ')}] at ${p.baseUrl}; set JUROR${index}_MODEL`);
  return { ...p, requested: `family:${families.join('|')}`, model, client: client.with({ model }) };
}

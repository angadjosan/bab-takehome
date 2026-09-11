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
 * Pinned Fireworks juror models (docs/BUILD_SPEC.md "Deployment target", verified 2026-09-10).
 * Used when the provider is Fireworks and the id is listed by GET /models; otherwise the newest
 * model of the juror's fallback family is resolved.
 */
export const PINNED_FIREWORKS_MODELS: Record<number, string> = {
  1: 'accounts/fireworks/models/deepseek-v4p1-flash',
  2: 'accounts/fireworks/models/gpt-oss-120b',
  3: 'accounts/fireworks/models/glm-5p2',
};
/** Fallback families (three distinct families). */
export const DEFAULT_FAMILIES: Record<number, string[]> = {
  1: ['deepseek'],
  2: ['gpt-oss'],
  3: ['glm'],
};
/** Reference-panel families: a juror in one of these shares a base family with the panel (disclosed). */
export const PANEL_FAMILIES = ['glm', 'kimi', 'qwen'];

export function sharesPanelFamily(modelId: string): boolean {
  const s = (modelId.split('/').pop() ?? modelId).toLowerCase();
  return PANEL_FAMILIES.some((f) => s.startsWith(f));
}
/**
 * Local Ollama preferences per juror (first installed model that answers a probe wins). Local
 * installs rarely have three families, so local runs record reduced model diversity.
 */
export const LOCAL_PREFERENCES: Record<number, string[]> = {
  1: ['gpt-oss:20b', 'gemma4:latest'],
  2: ['gemma4:latest', 'gpt-oss:20b'],
  3: ['gpt-oss:20b', 'gemma4:latest'],
};

/** First model in `prefs` (then any installed non-cloud model) that completes a 1-token probe. */
export async function pickWorkingLocalModel(client: LlmClient, prefs: string[]): Promise<string> {
  let installed: string[] = [];
  try {
    installed = (await client.listModels()).map((m) => m.id);
  } catch {
    /* fall through to probing the preferences directly */
  }
  const candidates = [...prefs.filter((m) => !installed.length || installed.includes(m)), ...installed.filter((m) => !prefs.includes(m) && !/cloud/i.test(m))];
  const failures: string[] = [];
  for (const model of candidates) {
    try {
      await client.chat({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 16, timeoutMs: 120_000 });
      return model;
    } catch (e) {
      failures.push(`${model}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  throw new Error(`no working local model (${failures.join('; ') || 'none installed'}); set JUROR{n}_MODEL or FIREWORKS_API_KEY`);
}
/** Never used for jurors: non-chat / non-text variants. */
export const JUROR_MODEL_EXCLUDE = /(guard|vision|embed|rerank|whisper|audio|image|tts|ocr|flux|-vl(-|$))/i;

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
    const model = await pickWorkingLocalModel(client, LOCAL_PREFERENCES[index] ?? LOCAL_PREFERENCES[1]!);
    return { ...p, requested: `local-default:${(LOCAL_PREFERENCES[index] ?? []).join('|')}`, model, client: client.with({ model }) };
  }
  const families = familiesFor(index, env);
  const models = opts.models ?? (await client.listModels());
  const pinned = p.kind === 'fireworks' && !env[`JUROR${index}_FAMILY`] ? PINNED_FIREWORKS_MODELS[index] : undefined;
  if (pinned && models.some((m) => m.id === pinned)) {
    return { ...p, requested: `pinned:${pinned}`, model: pinned, client: client.with({ model: pinned }) };
  }
  const model = chooseModel(models, families);
  if (!model) throw new Error(`no chat model in families [${families.join(', ')}] at ${p.baseUrl}; set JUROR${index}_MODEL`);
  return { ...p, requested: `family:${families.join('|')}`, model, client: client.with({ model }) };
}

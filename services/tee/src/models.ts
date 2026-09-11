/**
 * Reference panel + validator model resolution.
 *
 * Provider "fireworks": the panel is PINNED (BUILD_SPEC "Deployment target", shared `MODELS`):
 *   GLM 5.3  → accounts/fireworks/models/glm-5p3
 *   Kimi K3  → accounts/fireworks/models/kimi-k3
 *   Qwen 3.8 → accounts/fireworks/models/qwen3p8-max
 * and checked against the live GET /models list (shared `resolvePanel`). A pinned id that is not
 * listed falls back to the newest listed model of the same family (recorded as such); if the family
 * has none, the entry is `unavailable` — never silently substituted with another family.
 * Validator: accounts/fireworks/models/deepseek-v4-pro (VALIDATOR_MODEL overrides), a different family.
 *
 * Provider "ollama" (local dev harness check only): the panel entries are reported `unavailable`
 * and ONE extra entry, labeled `requested: "local harness check (not a panel model)"`, runs a
 * local model through the same harness.
 */
import { LlmClient, MODELS, resolvePanel } from '@envmarket/shared';
import type { LlmConfig } from './config.ts';
import { errMsg, logger } from './log.ts';

export const PANEL = MODELS.panel;
export const LOCAL_CHECK_LABEL = 'local harness check (not a panel model)';

export interface PanelEntry {
  requested: string;
  resolved: string | null;
  provider: string | null;
  status: 'run' | 'unavailable';
  reason: string | null;
  pinned: boolean;
  created: number | null;
}

export interface ResolvedModels {
  panel: PanelEntry[];
  validator: { model: string | null; provider: string | null; reason: string | null };
  listedAt: string;
}

export function llmClient(cfg: LlmConfig): LlmClient {
  return new LlmClient({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey ?? undefined, timeoutMs: 240_000, retries: 3 });
}

export async function resolveModels(cfg: LlmConfig): Promise<ResolvedModels> {
  const listedAt = new Date().toISOString();
  const unavailable = (reason: string): PanelEntry[] =>
    PANEL.map((p) => ({ requested: p.requested, resolved: null, provider: null, status: 'unavailable', reason, pinned: true, created: null }));

  if (cfg.provider === 'ollama') {
    const panel = unavailable('panel models are not served by the local Ollama endpoint; no substitution');
    let reason: string | null = null;
    try {
      const ids = (await llmClient(cfg).listModels()).map((m) => m.id);
      if (!ids.includes(cfg.localAgentModel)) reason = `local model ${cfg.localAgentModel} not pulled`;
    } catch (e) {
      reason = `ollama unreachable: ${errMsg(e)}`;
    }
    panel.push({
      requested: LOCAL_CHECK_LABEL,
      resolved: reason ? null : cfg.localAgentModel,
      provider: reason ? null : 'ollama-local',
      status: reason ? 'unavailable' : 'run',
      reason,
      pinned: false,
      created: null,
    });
    return { panel, validator: { model: cfg.localValidatorModel, provider: 'ollama-local', reason: null }, listedAt };
  }

  if (!cfg.apiKey) {
    return { panel: unavailable(`no API key for provider ${cfg.provider}`), validator: { model: null, provider: null, reason: 'no API key' }, listedAt };
  }
  const client = llmClient(cfg);
  try {
    const [resolved, listed] = await Promise.all([resolvePanel({ client, requireTools: true }), client.listModels()]);
    const panel: PanelEntry[] = resolved.map((m) =>
      m.listed
        ? {
            requested: m.requested,
            resolved: m.id,
            provider: cfg.provider,
            status: 'run',
            reason: m.pinned ? null : `pinned id not listed; newest listed ${m.family} model used`,
            pinned: m.pinned,
            created: m.created,
          }
        : { requested: m.requested, resolved: null, provider: null, status: 'unavailable', reason: `${m.id} is not listed by ${cfg.provider} and no ${m.family} model is available`, pinned: true, created: null },
    );
    const vm = cfg.validatorModel ?? MODELS.validator;
    const vListed = listed.some((m) => m.id === vm);
    return {
      panel,
      validator: vListed ? { model: vm, provider: cfg.provider, reason: null } : { model: null, provider: null, reason: `${vm} is not listed by ${cfg.provider}` },
      listedAt,
    };
  } catch (e) {
    const r = `model list unavailable: ${errMsg(e)}`;
    logger.warn('model resolution failed', { error: r });
    return { panel: unavailable(r), validator: { model: null, provider: null, reason: r }, listedAt };
  }
}

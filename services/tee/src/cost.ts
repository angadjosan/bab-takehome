/**
 * Preview inference cost model — constants and formulas from docs/PREVIEW_COST.md
 * ("envmarket.preview-cost.v1", measured 2026-09-10 on Fireworks serverless). Isolated here so a
 * re-measurement only touches this file.
 *
 *   episodeCost   = nTasks × Σ_models (expectedIn_m × in_m + expectedOut_m × out_m) / 1e6
 *   validatorCost = (ceil(min(validatorInputChars, 180000) / 3.4) × vIn + 3000 × vOut) / 1e6
 *   quote         = ceilToCent(episodeCost × 1.5 + validatorCost)                  (USDC)
 *   worstCase     = nTasks × Σ_models (fullIn_m × in_m + fullOut_m × out_m) / 1e6
 *                 + (ceil(180000 / 3.4) × vIn + 8192 × vOut) / 1e6
 * A cached preview (run reused) costs ~0 inference: fee = the contract's minPreviewFee.
 * The harness enforces fullBudgetIn/fullBudgetOut per episode (tokenBudgetFor), so worstCase is a
 * real bound, not an estimate.
 */
export const PREVIEW_COST = {
  version: 'envmarket.preview-cost.v1',
  measuredAt: '2026-09-10',
  currency: 'USDC',
  roundUpTo: 0.01,
  safetyMargin: 1.5,
  pricesUsdPerMTok: {
    'accounts/fireworks/models/glm-5p3': { in: 1.4, cachedIn: 0.26, out: 4.4 },
    'accounts/fireworks/models/kimi-k3': { in: 3.0, cachedIn: 0.3, out: 15.0 },
    'accounts/fireworks/models/qwen3p8-max': { in: 2.0, cachedIn: 0.25, out: 6.0 },
    'accounts/fireworks/models/deepseek-v4-pro-0813': { in: 1.32, cachedIn: 0.044, out: 3.96 },
  } as Record<string, { in: number; cachedIn: number; out: number }>,
  episodeTokens: {
    'accounts/fireworks/models/glm-5p3': { expectedIn: 24000, expectedOut: 5600, fullBudgetIn: 135000, fullBudgetOut: 21600 },
    'accounts/fireworks/models/kimi-k3': { expectedIn: 14000, expectedOut: 1900, fullBudgetIn: 120000, fullBudgetOut: 8200 },
    'accounts/fireworks/models/qwen3p8-max': { expectedIn: 27000, expectedOut: 4500, fullBudgetIn: 141000, fullBudgetOut: 17400 },
  } as Record<string, { expectedIn: number; expectedOut: number; fullBudgetIn: number; fullBudgetOut: number }>,
  validator: { model: 'accounts/fireworks/models/deepseek-v4-pro-0813', charsPerToken: 3.4, maxInputChars: 180000, expectedOut: 3000, maxOut: 8192 },
} as const;

export const COST_MODEL_VERSION = `${PREVIEW_COST.version}@${PREVIEW_COST.measuredAt}`;

type Price = { in: number; cachedIn: number; out: number };
type EpisodeTokens = { expectedIn: number; expectedOut: number; fullBudgetIn: number; fullBudgetOut: number };

const maxOf = <T extends Record<string, number>>(rows: T[]): T =>
  rows.reduce((a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, Math.max(a[k]!, b[k]!)])) as T);

/** Conservative fallback for a model without measurements: the maximum over measured models. */
const FALLBACK_PRICE: Price = maxOf(Object.values(PREVIEW_COST.pricesUsdPerMTok));
const FALLBACK_TOKENS: EpisodeTokens = maxOf(Object.values(PREVIEW_COST.episodeTokens));

const isLocal = (model: string) => !model.startsWith('accounts/');

export function priceFor(model: string): Price {
  if (isLocal(model)) return { in: 0, cachedIn: 0, out: 0 }; // local harness check (ollama): no provider bill
  return PREVIEW_COST.pricesUsdPerMTok[model] ?? FALLBACK_PRICE;
}

export function episodeTokensFor(model: string): EpisodeTokens {
  return PREVIEW_COST.episodeTokens[model] ?? FALLBACK_TOKENS;
}

/** Per-episode token bound enforced by the harness (null for local models: no bill to bound). */
export function tokenBudgetFor(model: string): { in: number; out: number } | null {
  if (isLocal(model)) return null;
  const t = episodeTokensFor(model);
  return { in: t.fullBudgetIn, out: t.fullBudgetOut };
}

export const ceilToCent = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface CostQuote {
  nTasks: number;
  models: string[];
  validatorModel: string | null;
  validatorInputChars: number;
  episodeCostUsd: number;
  validatorCostUsd: number;
  /** expected cost without margin */
  estimatedCostUsd: number;
  /** ceilToCent(episodeCost × 1.5 + validatorCost) */
  quoteUsd: number;
  worstCaseUsd: number;
}

export function quotePreviewCost(a: { models: string[]; nTasks: number; validatorModel: string | null; validatorInputChars?: number | null }): CostQuote {
  const v = PREVIEW_COST.validator;
  const vp = a.validatorModel ? priceFor(a.validatorModel) : { in: 0, cachedIn: 0, out: 0 };
  const chars = Math.min(a.validatorInputChars ?? v.maxInputChars, v.maxInputChars);
  let episode = 0;
  let worst = 0;
  for (const m of a.models) {
    const p = priceFor(m);
    const t = episodeTokensFor(m);
    episode += (t.expectedIn * p.in + t.expectedOut * p.out) / 1e6;
    worst += (t.fullBudgetIn * p.in + t.fullBudgetOut * p.out) / 1e6;
  }
  const episodeCostUsd = a.nTasks * episode;
  const validatorCostUsd = a.validatorModel ? (Math.ceil(chars / v.charsPerToken) * vp.in + v.expectedOut * vp.out) / 1e6 : 0;
  const worstValidator = a.validatorModel ? (Math.ceil(v.maxInputChars / v.charsPerToken) * vp.in + v.maxOut * vp.out) / 1e6 : 0;
  return {
    nTasks: a.nTasks,
    models: a.models,
    validatorModel: a.validatorModel,
    validatorInputChars: chars,
    episodeCostUsd: round6(episodeCostUsd),
    validatorCostUsd: round6(validatorCostUsd),
    estimatedCostUsd: round6(episodeCostUsd + validatorCostUsd),
    quoteUsd: a.models.length || a.validatorModel ? ceilToCent(episodeCostUsd * PREVIEW_COST.safetyMargin + validatorCostUsd) : 0,
    worstCaseUsd: round6(a.nTasks * worst + worstValidator),
  };
}

/** USDC base units (6 decimals), never below the on-chain minimum preview fee. */
export function feeUsdcBaseUnits(quoteUsd: number, minFee: bigint): bigint {
  const units = BigInt(Math.round(quoteUsd * 100)) * 10_000n; // quote is whole cents
  return units < minFee ? minFee : units;
}

/** Actual USD cost of measured usage (cached prompt tokens at the cached price). */
export function usageCostUsd(model: string, u: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }): number {
  const p = priceFor(model);
  const cached = Math.min(u.cachedPromptTokens ?? 0, u.promptTokens);
  return round6(((u.promptTokens - cached) * p.in + cached * p.cachedIn + u.completionTokens * p.out) / 1e6);
}

import { modelRuns } from "./docs";
import type { ModelResult } from "./tee";

/** One line under every reference-score block. */
export const REFERENCE_MODELS_NOTE = "Three open models run each task once inside the enclave: GLM 5.3, Kimi K3, Qwen 3.8. Scores show how today's models do, not training value.";

/**
 * Display name for a provider model id: "accounts/fireworks/models/glm-5p3" → "GLM 5.3",
 * "kimi-k3" → "Kimi K3", "qwen3p8-max" → "Qwen 3.8". Unknown ids fall back to their last path segment.
 */
export function modelName(id: string) {
  const s = id.split("/").pop() ?? id;
  const v = (a: string, b?: string) => (b ? `${a}.${b}` : a);
  let m = /^glm-(\d+)(?:p(\d+))?/i.exec(s);
  if (m) return `GLM ${v(m[1], m[2])}`;
  m = /^kimi-k(\d+)(?:p(\d+))?/i.exec(s);
  if (m) return `Kimi K${v(m[1], m[2])}`;
  m = /^qwen(\d+)(?:p(\d+))?/i.exec(s);
  if (m) return `Qwen ${v(m[1], m[2])}`;
  return s;
}

/** The reference panel's headline: mean purchased-task pass@1 over models whose runs actually ran. */
export function panelAverage(models: ModelResult[]) {
  const ran = models.filter((m) => modelRuns(m).ran && m.purchased.pass1Rounded !== null);
  if (!ran.length) return { avg: null as number | null, ran: 0, total: models.length };
  const avg = ran.reduce((s, m) => s + (m.purchased.pass1Rounded ?? 0), 0) / ran.length;
  return { avg, ran: ran.length, total: models.length };
}

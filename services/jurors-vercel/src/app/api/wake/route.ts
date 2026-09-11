/**
 * POST /api/wake  body {"disputeId"?: "12"}
 * Idempotent nudge from the web app (after openDispute), the buyer agent CLI, or anyone. It only
 * reads the chain and starts a juror workflow run for each unresolved FalseDescription dispute that
 * has none; with nothing pending it returns "nothing to do". Rate limited per IP.
 */
import { loadConfig } from '../../../lib/config.ts';
import { clientIp, corsHeaders, json, RateLimiter } from '../../../lib/http.ts';
import { wake } from '../../../lib/sweep.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const perIp = new RateLimiter(12, 60_000);
const global = new RateLimiter(120, 60_000);
let inflight: Promise<unknown> | null = null;

export function OPTIONS(req: Request): Response {
  const cfg = loadConfig();
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin'), cfg.allowedOrigins) });
}

export async function POST(req: Request): Promise<Response> {
  const cfg = loadConfig();
  const headers = corsHeaders(req.headers.get('origin'), cfg.allowedOrigins);
  if (!perIp.allow(clientIp(req)) || !global.allow('all')) return json({ ok: false, error: 'rate limited' }, { status: 429, headers: { ...headers, 'retry-after': '30' } });
  let focus: bigint | undefined;
  const text = (await req.text()).slice(0, 1024);
  if (text.trim()) {
    try {
      const body = JSON.parse(text) as { disputeId?: unknown };
      if (body.disputeId !== undefined && body.disputeId !== null) {
        const s = String(body.disputeId);
        if (!/^\d{1,30}$/.test(s)) throw new Error('bad disputeId');
        focus = BigInt(s);
      }
    } catch {
      return json({ ok: false, error: 'body must be JSON {"disputeId"?: "<decimal id>"}' }, { status: 400, headers });
    }
  }
  try {
    // Coalesce concurrent wakes on one instance into a single sweep.
    const p = inflight ?? (inflight = wake(cfg, focus).finally(() => (inflight = null)));
    const result = await p;
    return json({ ok: true, ...(result as object) }, { headers });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 502, headers });
  }
}

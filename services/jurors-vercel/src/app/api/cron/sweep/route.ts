/** Daily Vercel Cron safety net (Hobby: at most once per day): same sweep as POST /api/wake. */
import { loadConfig } from '../../../../lib/config.ts';
import { json } from '../../../../lib/http.ts';
import { wake } from '../../../../lib/sweep.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return json({ ok: false, error: 'unauthorized' }, { status: 401 });
  try {
    return json({ ok: true, source: 'cron', ...(await wake(loadConfig())) });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}

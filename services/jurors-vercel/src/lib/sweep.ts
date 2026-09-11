/**
 * Find FalseDescription disputes that are not resolved and make sure each has a live workflow run.
 * Used by POST /api/wake (every call) and the daily cron.
 *
 * Disputes are numbered 1..nextDisputeId-1, so a sweep reads `nextDisputeId` and `getDispute` for
 * the most recent MAX_SCAN ids instead of scanning DisputeOpened logs from the deployment block
 * (same result, a handful of eth_calls, no getLogs range limits as the chain grows).
 */
import { getHookByToken, getRun, start } from 'workflow/api';
import { jurorDisputeWorkflow } from '../workflows/dispute.ts';
import { loadAbi } from '../shared-lite.ts';
import { lockToken, publicClientFor, type ServiceConfig } from './config.ts';
import { DisputeStatus, Ground } from './types.ts';

export const MAX_SCAN = 200;
const STATUS = ['None', 'AwaitingSelection', 'Voting', 'Resolved'];

export interface OpenDispute {
  disputeId: string;
  status: string;
  round: number;
}

export async function openDisputes(cfg: ServiceConfig): Promise<{ nextDisputeId: bigint; open: OpenDispute[] }> {
  const pc = publicClientFor(cfg);
  const abi = loadAbi('EnvMarket');
  const next = (await pc.readContract({ address: cfg.market, abi, functionName: 'nextDisputeId' })) as bigint;
  const first = next - 1n > BigInt(MAX_SCAN) ? next - BigInt(MAX_SCAN) : 1n;
  const ids: bigint[] = [];
  for (let i = first; i < next; i++) ids.push(i);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const [d] = (await pc.readContract({ address: cfg.market, abi, functionName: 'getDispute', args: [id] })) as [{ ground: number; status: number; round: number }];
      return { id, ground: Number(d.ground), status: Number(d.status), round: Number(d.round) };
    }),
  );
  const open = rows
    .filter((r) => r.ground === Ground.FalseDescription && r.status !== DisputeStatus.Resolved && r.status !== DisputeStatus.None)
    .map((r) => ({ disputeId: r.id.toString(), status: STATUS[r.status] ?? String(r.status), round: r.round }));
  return { nextDisputeId: next, open };
}

export type WakeAction = 'started' | 'running' | 'would-start (JURORS_ENABLED is off)' | 'failed';

async function activeRun(token: string): Promise<string | null> {
  let hook: { runId: string } | null = null;
  try {
    hook = (await getHookByToken(token)) as { runId: string };
  } catch {
    return null; // no hook with this token: no run holds the lock
  }
  if (!hook?.runId) return null;
  try {
    const status = await getRun(hook.runId).status;
    return status === 'running' || status === 'pending' ? hook.runId : null;
  } catch {
    return hook.runId;
  }
}

export async function wake(cfg: ServiceConfig, focus?: bigint) {
  const { nextDisputeId, open } = await openDisputes(cfg);
  const results: Array<OpenDispute & { action: WakeAction; runId?: string; error?: string }> = [];
  for (const d of open) {
    const token = lockToken(cfg, d.disputeId);
    try {
      const running = await activeRun(token);
      if (running) {
        results.push({ ...d, action: 'running', runId: running });
      } else if (!cfg.enabled) {
        results.push({ ...d, action: 'would-start (JURORS_ENABLED is off)' });
      } else {
        const run = await start(jurorDisputeWorkflow, [{ disputeId: d.disputeId, lockToken: token }]);
        results.push({ ...d, action: 'started', runId: run.runId });
      }
    } catch (e) {
      results.push({ ...d, action: 'failed', error: (e as Error).message.slice(0, 200) });
    }
  }
  const focusNote =
    focus === undefined
      ? undefined
      : focus >= nextDisputeId || focus < 1n
        ? `dispute #${focus} does not exist (yet)`
        : open.some((d) => d.disputeId === focus.toString())
          ? undefined
          : `dispute #${focus} is resolved or not a FalseDescription dispute`;
  return {
    enabled: cfg.enabled,
    chainId: cfg.chainId,
    market: cfg.market,
    nextDisputeId,
    nothingToDo: results.length === 0,
    message: results.length === 0 ? 'nothing to do: no unresolved FalseDescription disputes' : `${results.length} open dispute(s)`,
    focus: focusNote,
    disputes: results,
  };
}

/**
 * The per-dispute loop: read the chain, plan, act, sleep. Pure orchestration (no Node.js imports):
 * inside the Vercel workflow, `snapshot`/`execute` are durable steps and `sleep` is the workflow's
 * durable sleep; in tests they are fakes. Memory is rebuilt deterministically from step results on
 * every replay, and every decision re-reads the chain first, so a replay, a retried step, or a new
 * run after a crash never double-commits and always reveals (see salt.ts).
 */
import { batches, planNext, POLL_SECONDS } from './planner.ts';
import { emptyMemory, key, type Action, type ActionResult, type Memory, type Snapshot } from './types.ts';

export const MAX_ITERATIONS = 400;
export const FAILED_ACTION_BACKOFF_SECONDS = 4;
const MAX_LOG = 200;

export interface DriverIO {
  snapshot(disputeId: string): Promise<Snapshot>;
  execute(disputeId: string, action: Action, mem: Memory): Promise<ActionResult>;
  sleep(seconds: number): Promise<void>;
}

export interface DriveResult {
  disputeId: string;
  outcome: string;
  iterations: number;
  log: string[];
}

function note(mem: Memory, line: string): Memory {
  const log = [...mem.log, line];
  return { ...mem, log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log };
}

/** Fold one action result into memory (pure; returns a new object). */
export function apply(mem: Memory, a: Action, r: ActionResult, s: Snapshot): Memory {
  const m: Memory = {
    ...mem,
    decisions: { ...mem.decisions },
    deliberationFailures: { ...mem.deliberationFailures },
    prepared: { ...mem.prepared },
    revealTx: { ...mem.revealTx },
    published: { ...mem.published },
    publishFailures: { ...mem.publishFailures },
    keeper: { ...mem.keeper },
    withdrawn: { ...mem.withdrawn },
    failures: { ...mem.failures },
  };
  const k = 'round' in a ? key(a.jurorIndex, a.round) : String(a.jurorIndex);
  switch (a.kind) {
    case 'select':
      m.keeper[`select:${a.round}:${s.dispute.selectionBlock}`] = { ok: r.ok, reason: r.ok ? undefined : r.reason, at: s.head.timestamp };
      break;
    case 'tally':
      m.keeper[`tally:${a.round}`] = { ok: r.ok, reason: r.ok ? undefined : r.reason, at: s.head.timestamp };
      break;
    case 'deliberate':
      if (r.ok && r.decision) m.decisions[k] = r.decision;
      else m.deliberationFailures[k] = (m.deliberationFailures[k] ?? 0) + 1;
      break;
    case 'prepare':
      if (r.ok && r.commitment && r.verdict) m.prepared[k] = { verdict: r.verdict, commitment: r.commitment };
      break;
    case 'reveal':
      if (r.ok && r.hash) m.revealTx[k] = r.hash;
      break;
    case 'publish':
      if (r.ok && r.sha256) m.published[k] = r.sha256;
      else m.publishFailures[k] = (m.publishFailures[k] ?? 0) + 1;
      break;
    case 'withdraw':
      if (r.ok && r.hash) m.withdrawn[k] = r.hash;
      else if (!r.ok) m.failures[`withdraw:${a.jurorIndex}`] = (m.failures[`withdraw:${a.jurorIndex}`] ?? 0) + 1;
      break;
    case 'commit':
      break;
  }
  // Never log a verdict or commitment before the reveal: only the action, juror and outcome.
  const what = `${a.kind}${'round' in a ? ` r${a.round}` : ''} juror${a.jurorIndex}`;
  return note(m, r.ok ? `${what}: ok${r.hash ? ` ${r.hash}` : ''}${r.note ? ` (${r.note})` : ''}` : `${what}: not applied (${r.reason})`);
}

export async function driveDispute(disputeId: string, io: DriverIO, maxIterations = MAX_ITERATIONS): Promise<DriveResult> {
  let mem = emptyMemory();
  for (let i = 1; i <= maxIterations; i++) {
    let snap: Snapshot;
    try {
      snap = await io.snapshot(disputeId);
    } catch (e) {
      mem = note(mem, `snapshot failed: ${(e as Error).message}`);
      await io.sleep(POLL_SECONDS);
      continue;
    }
    const plan = planNext(snap, mem);
    if (plan.kind === 'done') return { disputeId, outcome: plan.outcome, iterations: i, log: mem.log };
    if (plan.kind === 'wait') {
      await io.sleep(plan.seconds);
      continue;
    }
    let progressed = false;
    for (const batch of batches(plan.actions)) {
      const results = await Promise.all(
        batch.map((a) =>
          io.execute(disputeId, a, mem).catch((e): ActionResult => ({ ok: false, kind: a.kind, reason: `step failed: ${(e as Error).message}`, retryable: true })),
        ),
      );
      batch.forEach((a, n) => {
        const r = results[n]!;
        mem = apply(mem, a, r, snap);
        if (r.ok) progressed = true;
      });
    }
    if (!progressed) await io.sleep(FAILED_ACTION_BACKOFF_SECONDS);
  }
  return { disputeId, outcome: `stopped after ${maxIterations} iterations (the next wake or cron sweep starts a fresh run)`, iterations: maxIterations, log: mem.log };
}

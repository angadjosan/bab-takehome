/**
 * One durable workflow run per FalseDescription dispute. Started by POST /api/wake or the cron
 * sweep; a deterministic hook token is the lock, so concurrent wakes can never start two runs that
 * act for the same dispute (the second sees the conflict and exits).
 */
import { createHook, sleep } from 'workflow';
import { driveDispute, type DriveResult } from '../lib/driver.ts';
import { key, type Action, type ActionResult, type Memory } from '../lib/types.ts';
import { commitVote, deliberate, keeperSelect, keeperTally, prepareVote, publishRationale, readSnapshot, revealVote, withdrawRewards } from './steps.ts';

export interface DisputeRunInput {
  disputeId: string;
  lockToken: string;
}

function execute(disputeId: string, a: Action, mem: Memory): Promise<ActionResult> {
  switch (a.kind) {
    case 'select':
      return keeperSelect(disputeId, a.jurorIndex);
    case 'tally':
      return keeperTally(disputeId, a.jurorIndex);
    case 'deliberate':
      return deliberate(disputeId, a.round, a.jurorIndex, a.commitDeadline);
    case 'prepare':
      return prepareVote(disputeId, a.round, a.jurorIndex, a.verdict);
    case 'commit':
      return commitVote(disputeId, a.round, a.jurorIndex, a.verdict, a.commitment);
    case 'reveal':
      return revealVote(disputeId, a.round, a.jurorIndex, a.verdict ?? null);
    case 'publish': {
      const k = key(a.jurorIndex, a.round);
      const rec = mem.decisions[k];
      if (!rec) return Promise.resolve({ ok: false, kind: 'publish', reason: 'no decision in this run', retryable: false });
      return publishRationale(disputeId, a.round, a.jurorIndex, rec, mem.revealTx[k] ?? null);
    }
    case 'withdraw':
      return withdrawRewards(a.jurorIndex);
  }
}

export async function jurorDisputeWorkflow(input: DisputeRunInput): Promise<DriveResult | { disputeId: string; outcome: string; runId?: string }> {
  'use workflow';
  const hook = createHook<{ wake: true }>({ token: input.lockToken });
  const conflict = await hook.getConflict();
  if (conflict) return { disputeId: input.disputeId, outcome: 'another run already owns this dispute', runId: conflict.runId };
  try {
    return await driveDispute(input.disputeId, {
      snapshot: readSnapshot,
      execute,
      sleep: (seconds) => sleep(`${Math.max(1, Math.ceil(seconds))}s`),
    });
  } finally {
    hook.dispose();
  }
}

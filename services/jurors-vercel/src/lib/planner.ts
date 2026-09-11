/**
 * The juror state machine for one dispute, as a pure function of (chain snapshot, memory).
 * Pure and deterministic (runs inside the workflow sandbox): no I/O, no clock other than the
 * chain head timestamp in the snapshot.
 *
 * Per seated juror of ours, in the current round:
 *   no commitment, before commitDeadline:  deliberate -> prepare (fix verdict + commitment) -> commit
 *   committed, reveal open*, not revealed: reveal (salt re-derived from the key, verdict recovered
 *                                          from the on-chain commitment if memory was lost)
 *   revealed:                              publish the screened rationale to the TEE
 *   (*) reveal opens after commitDeadline, or once every seat of the round has committed.
 * Keeper (anyone may call; we do it with KEEPER_JUROR's key):
 *   AwaitingSelection and block > selectionBlock -> selectJurors (after NotEnoughJurors, retry once
 *     selectionDeadline passes so the contract can fail the round over)
 *   Voting and (all revealed or revealDeadline passed) -> tallyDispute
 * Resolved: publish anything left, withdraw rewards for each of our jurors, done.
 */
import { DisputeStatus, Ground, key, SEATS, VerdictCode, ZERO32, type Action, type Memory, type Plan, type Snapshot } from './types.ts';

export const POLL_SECONDS = 10;
export const SELECTION_POLL_SECONDS = 3;
export const EVIDENCE_RETRY_SECONDS = 8;
export const MAX_DELIBERATION_FAILURES = 6;
export const MAX_PUBLISH_FAILURES = 5;
export const MAX_WITHDRAW_FAILURES = 3;
/** Don't start a deliberation this close to the commit deadline (it could not be committed in time). */
export const MIN_SECONDS_TO_DELIBERATE = 15;
/** Seconds past a deadline before acting on it (block timestamps vs. our clock). */
export const DEADLINE_SLACK = 2;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function planNext(s: Snapshot, mem: Memory): Plan {
  const d = s.dispute;
  if (!s.enabled) return { kind: 'done', outcome: 'disabled (JURORS_ENABLED is not 1)' };
  if (d.status === DisputeStatus.None) return { kind: 'done', outcome: 'dispute not found' };
  if (d.ground !== Ground.FalseDescription) return { kind: 'done', outcome: 'not a FalseDescription dispute (mechanical verifier handles it)' };

  const now = s.head.timestamp;
  const keeper = s.keeperIndex;

  if (d.status === DisputeStatus.Resolved) {
    const actions: Action[] = [];
    for (const j of s.jurors) {
      s.seats.forEach((seat, i) => {
        const round = Math.floor(i / SEATS) + 1;
        const k = key(j.index, round);
        if (same(seat.juror, j.address) && seat.revealed && mem.decisions[k] && !mem.published[k] && (mem.publishFailures[k] ?? 0) < MAX_PUBLISH_FAILURES) {
          actions.push({ kind: 'publish', round, jurorIndex: j.index });
        }
      });
      if (j.claimable > 0n && (mem.failures[`withdraw:${j.index}`] ?? 0) < MAX_WITHDRAW_FAILURES) actions.push({ kind: 'withdraw', jurorIndex: j.index });
    }
    if (actions.length) return { kind: 'act', actions, note: 'resolved: publish leftovers and withdraw' };
    const verdict = d.fallbackNoQuorum ? 'FallbackNoQuorum' : d.verdict === VerdictCode.Uphold ? 'Uphold' : 'Reject';
    return { kind: 'done', outcome: `resolved: ${verdict}` };
  }

  if (d.status === DisputeStatus.AwaitingSelection) {
    if (s.head.number <= d.selectionBlock) return { kind: 'wait', seconds: SELECTION_POLL_SECONDS, note: `waiting for block > ${d.selectionBlock}` };
    const last = mem.keeper[`select:${d.round}:${d.selectionBlock}`];
    if (last && !last.ok && /NotEnoughJurors/.test(last.reason ?? '') && now <= d.selectionDeadline) {
      const secs = Number(d.selectionDeadline - now) + DEADLINE_SLACK;
      return { kind: 'wait', seconds: Math.max(SELECTION_POLL_SECONDS, secs), note: `not enough eligible jurors; retry after selectionDeadline ${d.selectionDeadline}` };
    }
    return { kind: 'act', actions: [{ kind: 'select', round: d.round, jurorIndex: keeper }], note: `selectJurors round ${d.round}` };
  }

  if (d.status !== DisputeStatus.Voting) return { kind: 'wait', seconds: POLL_SECONDS, note: `unknown status ${d.status}` };

  const round = d.round;
  const panel = s.seats.slice((round - 1) * SEATS, round * SEATS);
  const allCommitted = panel.length === SEATS && panel.every((p) => p.commitment !== ZERO32);
  const allRevealed = panel.length === SEATS && panel.every((p) => p.revealed);
  const revealOpen = (now > d.commitDeadline || allCommitted) && now <= d.revealDeadline;
  const actions: Action[] = [];
  const waits: number[] = [];

  for (const j of s.jurors) {
    const seat = panel.find((p) => same(p.juror, j.address));
    if (!seat) continue;
    const k = key(j.index, round);
    if (seat.commitment === ZERO32) {
      if (now > d.commitDeadline) continue; // missed: nothing left to do for this seat
      const dec = mem.decisions[k];
      const prep = mem.prepared[k];
      if (prep) actions.push({ kind: 'commit', round, jurorIndex: j.index, verdict: prep.verdict, commitment: prep.commitment });
      else if (dec) actions.push({ kind: 'prepare', round, jurorIndex: j.index, verdict: dec.verdict });
      else if ((mem.deliberationFailures[k] ?? 0) >= MAX_DELIBERATION_FAILURES) continue; // abstain: kept failing
      else if (d.commitDeadline - now < BigInt(MIN_SECONDS_TO_DELIBERATE)) continue; // abstain: no time left
      else actions.push({ kind: 'deliberate', round, jurorIndex: j.index, commitDeadline: d.commitDeadline });
    } else if (!seat.revealed) {
      if (revealOpen) actions.push({ kind: 'reveal', round, jurorIndex: j.index, verdict: mem.prepared[k]?.verdict ?? mem.decisions[k]?.verdict });
      else if (now <= d.commitDeadline) waits.push(Number(d.commitDeadline - now) + DEADLINE_SLACK);
    } else if (mem.decisions[k] && !mem.published[k] && (mem.publishFailures[k] ?? 0) < MAX_PUBLISH_FAILURES) {
      actions.push({ kind: 'publish', round, jurorIndex: j.index });
    }
  }

  if (allRevealed || now > d.revealDeadline) {
    actions.push({ kind: 'tally', round, jurorIndex: keeper });
  } else if (!allCommitted && now <= d.commitDeadline) {
    waits.push(Number(d.commitDeadline - now) + DEADLINE_SLACK);
  } else {
    waits.push(Number(d.revealDeadline - now) + DEADLINE_SLACK);
  }

  if (actions.length) return { kind: 'act', actions, note: actions.map((a) => `${a.kind}#${a.jurorIndex}`).join(' ') };
  // Nothing to do right now: wake at the next deadline, polling meanwhile for other jurors' moves.
  const failures = Object.values(mem.deliberationFailures).some((n) => n > 0) ? EVIDENCE_RETRY_SECONDS : POLL_SECONDS;
  const seconds = Math.max(DEADLINE_SLACK, Math.min(failures, ...waits));
  return { kind: 'wait', seconds, note: `round ${round}: waiting (committed ${panel.filter((p) => p.commitment !== ZERO32).length}/3, revealed ${panel.filter((p) => p.revealed).length}/3)` };
}

/** Group actions so that each juror key sends at most one transaction at a time (nonce safety). */
export function batches(actions: Action[]): Action[][] {
  const out: Action[][] = [];
  const pending = [...actions];
  while (pending.length) {
    const used = new Set<number>();
    const batch: Action[] = [];
    for (let i = 0; i < pending.length; ) {
      const a = pending[i]!;
      // deliberate/prepare/publish send no transaction; only one tx per key per batch
      const sendsTx = a.kind !== 'deliberate' && a.kind !== 'prepare' && a.kind !== 'publish';
      if (sendsTx && used.has(a.jurorIndex)) {
        i++;
        continue;
      }
      if (sendsTx) used.add(a.jurorIndex);
      batch.push(a);
      pending.splice(i, 1);
    }
    out.push(batch);
  }
  return out;
}

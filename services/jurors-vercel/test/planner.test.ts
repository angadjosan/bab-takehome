import { describe, expect, it } from 'vitest';
import { batches, planNext } from '../src/lib/planner.ts';
import { DisputeStatus, emptyMemory, Ground, ZERO32, type Memory, type Snapshot } from '../src/lib/types.ts';

const J = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3'];
const C = `0x${'cc'.repeat(32)}` as const;

function snap(over: Partial<Snapshot['dispute']> = {}, seats: Partial<Snapshot['seats'][number]>[] = [], ts = 1000n): Snapshot {
  return {
    disputeId: '1',
    head: { number: 500n, timestamp: ts },
    enabled: true,
    keeperIndex: 1,
    dispute: {
      purchaseId: 1n,
      ground: Ground.FalseDescription,
      status: DisputeStatus.Voting,
      verdict: 0,
      round: 1,
      fallbackNoQuorum: false,
      selectionBlock: 100n,
      selectionDeadline: 2000n,
      commitDeadline: 1180n,
      revealDeadline: 1360n,
      ...over,
    },
    seats: Array.from({ length: 6 }, (_, i) => ({ juror: i < 3 ? J[i]! : '0x0000000000000000000000000000000000000000', vote: 0, revealed: false, commitment: ZERO32, ...(seats[i] ?? {}) })),
    jurors: J.map((address, i) => ({ index: i + 1, address, claimable: 0n })),
  };
}

const mem = (over: Partial<Memory> = {}): Memory => ({ ...emptyMemory(), ...over });

describe('planNext', () => {
  it('stops when disabled or not a FalseDescription dispute', () => {
    expect(planNext({ ...snap(), enabled: false }, mem()).kind).toBe('done');
    expect(planNext(snap({ ground: Ground.BrokenOrHashMismatch }), mem())).toMatchObject({ kind: 'done' });
    expect(planNext(snap({ status: DisputeStatus.None }), mem())).toMatchObject({ kind: 'done', outcome: 'dispute not found' });
  });

  it('waits for block > selectionBlock, then selects with the keeper key', () => {
    const s = snap({ status: DisputeStatus.AwaitingSelection, selectionBlock: 600n });
    expect(planNext(s, mem())).toMatchObject({ kind: 'wait' });
    const ready = snap({ status: DisputeStatus.AwaitingSelection, selectionBlock: 400n });
    expect(planNext(ready, mem())).toMatchObject({ kind: 'act', actions: [{ kind: 'select', jurorIndex: 1, round: 1 }] });
  });

  it('after NotEnoughJurors waits until selectionDeadline, then retries (so the round can fail over)', () => {
    const s = snap({ status: DisputeStatus.AwaitingSelection, round: 2, selectionBlock: 400n, selectionDeadline: 1300n });
    const m = mem({ keeper: { 'select:2:400': { ok: false, reason: 'NotEnoughJurors', at: 990n } } });
    const p = planNext(s, m);
    expect(p).toMatchObject({ kind: 'wait' });
    expect((p as { seconds: number }).seconds).toBe(302);
    expect(planNext({ ...s, head: { number: 900n, timestamp: 1301n } }, m)).toMatchObject({ kind: 'act', actions: [{ kind: 'select' }] });
  });

  it('seated and uncommitted: deliberate, then prepare, then commit', () => {
    expect(planNext(snap(), mem()).kind).toBe('act');
    const p1 = planNext(snap(), mem());
    expect(p1.kind === 'act' && p1.actions.map((a) => a.kind)).toEqual(['deliberate', 'deliberate', 'deliberate']);
    const p2 = planNext(snap(), mem({ decisions: { '1:1': { verdict: 'Reject', decision: {} } } }));
    expect(p2.kind === 'act' && p2.actions[0]).toMatchObject({ kind: 'prepare', jurorIndex: 1, verdict: 'Reject' });
    const p3 = planNext(snap(), mem({ prepared: { '1:1': { verdict: 'Reject', commitment: C } } }));
    expect(p3.kind === 'act' && p3.actions[0]).toMatchObject({ kind: 'commit', jurorIndex: 1, commitment: C });
  });

  it('never commits when the seat already holds a commitment', () => {
    const s = snap({}, [{ commitment: C }, { commitment: C }, { commitment: C }], 1100n);
    const p = planNext(s, mem({ prepared: { '1:1': { verdict: 'Uphold', commitment: C } } }));
    expect(p.kind === 'act' && p.actions.every((a) => a.kind !== 'commit')).toBe(true);
  });

  it('reveals as soon as all three committed (before commitDeadline), passing the remembered verdict', () => {
    const s = snap({}, [{ commitment: C }, { commitment: C }, { commitment: C }], 1100n);
    const p = planNext(s, mem({ prepared: { '2:1': { verdict: 'Reject', commitment: C } } }));
    expect(p.kind === 'act' && p.actions.map((a) => a.kind)).toEqual(['reveal', 'reveal', 'reveal']);
    expect(p.kind === 'act' && p.actions[1]).toMatchObject({ kind: 'reveal', jurorIndex: 2, verdict: 'Reject' });
  });

  it('waits for the commit deadline while another seat has not committed', () => {
    const s = snap({}, [{ commitment: C }, { commitment: C }, { juror: '0x00000000000000000000000000000000000000e1' }], 1100n);
    const p = planNext({ ...s, jurors: s.jurors.slice(0, 2) }, mem());
    expect(p).toMatchObject({ kind: 'wait' });
    expect((p as { seconds: number }).seconds).toBeLessThanOrEqual(10);
  });

  it('abstains when too close to the commit deadline or after repeated failures', () => {
    const late = snap({}, [], 1170n);
    expect(planNext(late, mem()).kind).toBe('wait');
    const failing = mem({ deliberationFailures: { '1:1': 6, '2:1': 6, '3:1': 6 } });
    expect(planNext(snap(), failing).kind).toBe('wait');
  });

  it('publishes after reveal, tallies once all revealed or after revealDeadline', () => {
    const revealed = [{ commitment: C, revealed: true, vote: 1 }, { commitment: C, revealed: true, vote: 1 }, { commitment: C, revealed: true, vote: 2 }];
    const p = planNext(snap({}, revealed, 1200n), mem({ decisions: { '1:1': { verdict: 'Uphold', decision: {} } } }));
    expect(p.kind === 'act' && p.actions.map((a) => a.kind)).toEqual(['publish', 'tally']);
    const partial = [{ commitment: C, revealed: true, vote: 1 }, { commitment: C }, { commitment: C }];
    const before = planNext({ ...snap({}, partial, 1300n), jurors: snap().jurors.slice(0, 1) }, mem({ published: { '1:1': C } }));
    expect(before.kind).toBe('wait');
    const after = planNext({ ...snap({}, partial, 1361n), jurors: snap().jurors.slice(0, 1) }, mem({ published: { '1:1': C } }));
    expect(after).toMatchObject({ kind: 'act', actions: [{ kind: 'tally', jurorIndex: 1 }] });
  });

  it('resolved: withdraws claimable rewards, then done', () => {
    const s = snap({ status: DisputeStatus.Resolved, verdict: 1 });
    s.jurors[1]!.claimable = 3_000_000n;
    expect(planNext(s, mem())).toMatchObject({ kind: 'act', actions: [{ kind: 'withdraw', jurorIndex: 2 }] });
    s.jurors[1]!.claimable = 0n;
    expect(planNext(s, mem())).toMatchObject({ kind: 'done', outcome: 'resolved: Uphold' });
    expect(planNext(snap({ status: DisputeStatus.Resolved, fallbackNoQuorum: true }), mem())).toMatchObject({ kind: 'done', outcome: 'resolved: FallbackNoQuorum' });
  });

  it('gives up on withdraw after repeated failures so the run can finish', () => {
    const s = snap({ status: DisputeStatus.Resolved, verdict: 2 });
    s.jurors[0]!.claimable = 1n;
    expect(planNext(s, mem({ failures: { 'withdraw:1': 3 } })).kind).toBe('done');
  });
});

describe('batches', () => {
  it('keeps one transaction per juror key per batch; non-tx actions ride along', () => {
    const b = batches([
      { kind: 'reveal', round: 1, jurorIndex: 1 },
      { kind: 'publish', round: 1, jurorIndex: 1 },
      { kind: 'tally', round: 1, jurorIndex: 1 },
      { kind: 'reveal', round: 1, jurorIndex: 2 },
    ]);
    expect(b.map((x) => x.map((a) => `${a.kind}${a.jurorIndex}`))).toEqual([['reveal1', 'publish1', 'reveal2'], ['tally1']]);
  });
});

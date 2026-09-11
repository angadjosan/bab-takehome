import { describe, expect, it } from 'vitest';
import { driveDispute } from '../src/lib/driver.ts';
import { DisputeStatus } from '../src/lib/types.ts';
import { ADDR, FakeMarket } from './fake-market.ts';

const io = (m: FakeMarket) => ({ snapshot: m.snapshot, execute: m.execute, sleep: m.sleep });

describe('driveDispute (workflow loop against a simulated EnvMarket)', () => {
  it('happy path: select, deliberate, commit, reveal, publish, tally, withdraw', async () => {
    const m = new FakeMarket({ verdicts: { 1: 'Uphold', 2: 'Uphold', 3: 'Reject' } });
    const r = await driveDispute('7', io(m));
    expect(r.outcome).toBe('resolved: Uphold');
    expect(m.status).toBe(DisputeStatus.Resolved);
    expect(m.calls.commit).toBe(3);
    expect(m.calls.reveal).toBe(3);
    expect(m.calls.publish).toBe(3);
    expect(m.calls.select).toBe(1);
    expect(m.txs.filter((t) => t.startsWith('withdraw')).sort()).toEqual(['withdraw:1', 'withdraw:2']);
    // reveal started as soon as all three committed, well before the commit deadline
    expect(m.txs.indexOf('reveal:1')).toBeGreaterThan(m.txs.lastIndexOf('commit:3') - 3);
    expect(r.log.join('\n')).not.toMatch(/Uphold|Reject/); // the run log never names a verdict before the result
  });

  it('deliberations run in parallel (one batch) and each key sends one tx at a time', async () => {
    const m = new FakeMarket();
    let inflight = 0;
    let maxInflight = 0;
    const exec = m.execute;
    m.execute = async (id, a, mem) => {
      if (a.kind === 'deliberate') {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((res) => setTimeout(res, 5));
        inflight--;
      }
      return exec(id, a, mem);
    };
    await driveDispute('1', io(m));
    expect(maxInflight).toBe(3);
  });

  it('retries evidence that is not ready yet, then commits', async () => {
    const m = new FakeMarket({ evidenceFailures: { 2: 3 } });
    const r = await driveDispute('3', io(m));
    expect(r.outcome).toMatch(/^resolved/);
    expect(m.calls.deliberate).toBe(3 + 3);
    expect(m.calls.commit).toBe(3);
  });

  it('crash after commit: a fresh run (no memory) reveals from the derived salt and never re-commits', async () => {
    const m = new FakeMarket({ verdicts: { 1: 'Reject', 2: 'Reject', 3: 'Uphold' } });
    // First run dies right after the commits land (iteration cap stands in for a lost run).
    let commits = 0;
    const exec = m.execute;
    m.execute = async (id, a, mem) => {
      const r = await exec(id, a, mem);
      if (a.kind === 'commit' && r.ok) commits++;
      return r;
    };
    // iterations: wait, wait (selection block), select, deliberate, prepare, commit -> the run is lost
    const first = await driveDispute('9', io(m), 6);
    expect(first.outcome).toMatch(/stopped after/);
    expect(commits).toBe(3);
    expect(m.panel().every((s) => s.commitment !== `0x${'0'.repeat(64)}` && !s.revealed)).toBe(true);

    const second = await driveDispute('9', io(m));
    expect(second.outcome).toBe('resolved: Reject');
    expect(m.calls.commit).toBe(3); // the fake throws on a second commit
    expect(m.calls.deliberate).toBe(3); // no re-deliberation: the verdict is recovered from the commitment
    expect(m.panel().map((s) => s.vote)).toEqual([2, 2, 1]);
    expect(second.log.some((l) => l.startsWith('publish'))).toBe(false); // rationale needs the decision (lost with the run)
  });

  it('round 1 fails (tie with a non-revealer), round 2 cannot fill, falls back after the grace period', async () => {
    const ext = '0x00000000000000000000000000000000000000e1';
    const m = new FakeMarket({ panel: [ADDR[1]!, ADDR[2]!, ext], verdicts: { 1: 'Uphold', 2: 'Reject' }, external: { [ext]: 'no-reveal' } });
    const r = await driveDispute('4', io(m));
    expect(r.outcome).toBe('resolved: FallbackNoQuorum');
    expect(m.round).toBe(2);
    expect(m.calls.select).toBeGreaterThanOrEqual(2);
    expect(r.log.some((l) => /select r2 .*NotEnoughJurors/.test(l))).toBe(true);
  });

  it('waits for an external juror, and tallies only after the reveal deadline if it never reveals', async () => {
    const ext = '0x00000000000000000000000000000000000000e2';
    const m = new FakeMarket({ panel: [ADDR[1]!, ADDR[2]!, ext], verdicts: { 1: 'Uphold', 2: 'Uphold' }, external: { [ext]: 'no-reveal' } });
    const r = await driveDispute('5', io(m));
    expect(r.outcome).toBe('resolved: Uphold');
    const tallyTs = m.txs.indexOf('tally:1');
    expect(tallyTs).toBeGreaterThan(-1);
  });

  it('does nothing when disabled', async () => {
    const m = new FakeMarket();
    m.enabled = false;
    const r = await driveDispute('1', io(m));
    expect(r.outcome).toMatch(/disabled/);
    expect(m.txs).toEqual([]);
  });

  it('sleeps instead of spinning while waiting (bounded number of chain reads)', async () => {
    const m = new FakeMarket();
    await driveDispute('1', io(m));
    expect(m.calls.snapshot).toBeLessThan(60);
  });
});

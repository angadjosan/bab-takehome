import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { voteCommitment } from '@envmarket/shared';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { commitmentOf, newSalt, prepareCommit, VERDICT_CODE } from '../src/commit.ts';
import { JurorStore } from '../src/state.ts';

const CAST = [path.join(homedir(), '.foundry/bin/cast'), '/usr/local/bin/cast'].find((p) => existsSync(p));

function castCommitment(disputeId: bigint, round: number, verdict: number, salt: Hex, juror: Address): Hex {
  const enc = execFileSync(CAST!, ['abi-encode', 'f(uint256,uint8,uint8,bytes32,address)', disputeId.toString(), String(round), String(verdict), salt, juror], {
    encoding: 'utf8',
  }).trim();
  return execFileSync(CAST!, ['keccak', enc], { encoding: 'utf8' }).trim() as Hex;
}

const JUROR: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const vectors: Array<[bigint, number, 'Uphold' | 'Reject', Hex, Address]> = [
  [1n, 1, 'Uphold', `0x${'11'.repeat(32)}`, JUROR],
  [1n, 2, 'Reject', `0x${'00'.repeat(31)}01`, JUROR],
  [2n ** 255n + 7n, 1, 'Reject', `0x${'ff'.repeat(32)}`, '0x0000000000000000000000000000000000000001'],
  [42n, 2, 'Uphold', newSalt(), '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
];

describe('vote commitment encoding', () => {
  it('verdict codes mirror the Solidity enum', () => {
    expect(VERDICT_CODE).toEqual({ Uphold: 1, Reject: 2 });
  });

  it.skipIf(!CAST)('matches cast abi-encode + keccak (Solidity abi.encode)', () => {
    for (const [id, round, v, salt, juror] of vectors) {
      expect(commitmentOf({ disputeId: id, round, verdict: v, salt, juror })).toBe(castCommitment(id, round, VERDICT_CODE[v], salt, juror));
    }
  });

  it('matches @envmarket/shared voteCommitment', () => {
    for (const [id, round, v, salt, juror] of vectors) {
      expect(commitmentOf({ disputeId: id, round, verdict: v, salt, juror })).toBe(
        voteCommitment({ disputeId: id, round, verdict: VERDICT_CODE[v], salt: salt.toLowerCase() as Hex, juror }),
      );
    }
  });

  it('binds every field', () => {
    const base = { disputeId: 5n, round: 1, verdict: 'Uphold' as const, salt: `0x${'ab'.repeat(32)}` as Hex, juror: JUROR };
    const c = commitmentOf(base);
    expect(commitmentOf({ ...base, disputeId: 6n })).not.toBe(c);
    expect(commitmentOf({ ...base, round: 2 })).not.toBe(c);
    expect(commitmentOf({ ...base, verdict: 'Reject' })).not.toBe(c);
    expect(commitmentOf({ ...base, salt: `0x${'ac'.repeat(32)}` })).not.toBe(c);
    expect(commitmentOf({ ...base, juror: '0x0000000000000000000000000000000000000002' })).not.toBe(c);
  });

  it('rejects malformed salts', () => {
    expect(() => commitmentOf({ disputeId: 1n, round: 1, verdict: 'Uphold', salt: '0x1234', juror: JUROR })).toThrow();
  });

  it('salts are 32 random bytes', () => {
    const s = new Set(Array.from({ length: 50 }, newSalt));
    expect(s.size).toBe(50);
    for (const x of s) expect(x).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('salt persistence', () => {
  const MARKET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

  it('persists salt + verdict + commitment durably before returning, and never regenerates', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'juror-state-'));
    const file = path.join(dir, 'juror1.json');
    const s1 = new JurorStore(file, JUROR, 31337, MARKET, 10n);
    const a = prepareCommit(s1, 3n, 1, 'Uphold', JUROR);
    // what a crashed-then-restarted process sees on disk
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    const rec = onDisk.deployments[`31337:${MARKET.toLowerCase()}`].disputes['3'].rounds['1'];
    expect(rec).toMatchObject({ verdict: 'Uphold', salt: a.salt, commitment: a.commitment });
    expect(a.commitment).toBe(commitmentOf({ disputeId: 3n, round: 1, verdict: 'Uphold', salt: a.salt, juror: JUROR }));

    const s2 = new JurorStore(file, JUROR, 31337, MARKET, 10n);
    // a restarted process with a different (re-run) verdict must reuse the persisted secret
    const b = prepareCommit(s2, 3n, 1, 'Reject', JUROR);
    expect(b).toEqual(a);
    // a new round gets a fresh secret
    const c = prepareCommit(s2, 3n, 2, 'Reject', JUROR);
    expect(c.salt).not.toBe(a.salt);
    expect(c.verdict).toBe('Reject');
  });

  it('keeps separate state per deployment and starts the cursor at startBlock - 1', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'juror-state-'));
    const file = path.join(dir, 'juror1.json');
    const s1 = new JurorStore(file, JUROR, 31337, MARKET, 100n);
    expect(s1.cursor).toBe(99n);
    s1.setCursor(150n);
    s1.setCursor(120n); // never moves backwards
    expect(new JurorStore(file, JUROR, 31337, MARKET, 100n).cursor).toBe(150n);
    const other = new JurorStore(file, JUROR, 31337, '0x0000000000000000000000000000000000000abc', 5n);
    expect(other.cursor).toBe(4n);
    expect(new JurorStore(file, JUROR, 31337, MARKET, 100n).cursor).toBe(150n);
  });

  it('refuses a state file that belongs to another juror', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'juror-state-'));
    const file = path.join(dir, 'juror1.json');
    new JurorStore(file, JUROR, 31337, MARKET, 1n);
    expect(() => new JurorStore(file, '0x0000000000000000000000000000000000000009', 31337, MARKET, 1n)).toThrow(/belongs to/);
  });
});

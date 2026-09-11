import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { deriveVoteSalt, recoverVerdict, saltMessage } from '../src/lib/salt.ts';
import { commitmentOf, VERDICT_CODE } from '../src/vendor/jurors/src/commit.ts';

const CAST = [path.join(homedir(), '.foundry/bin/cast'), '/usr/local/bin/cast', '/opt/homebrew/bin/cast'].find((p) => existsSync(p));
const KEY: Hex = `0x${'42'.repeat(32)}`;
const JUROR = privateKeyToAccount(KEY).address;
const MARKET: Address = '0x2fd644342296df7de57929fa87bd65c05fb415f8';
const base = { chainId: 84532, market: MARKET, disputeId: 12n, round: 1, juror: JUROR };

describe('derived vote salts', () => {
  it('are deterministic, bytes32, and bound to chain, market, dispute, round, juror and key', () => {
    const s = deriveVoteSalt(KEY, base);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveVoteSalt(KEY, base)).toBe(s);
    const variants = [
      deriveVoteSalt(KEY, { ...base, chainId: 8453 }),
      deriveVoteSalt(KEY, { ...base, market: '0x0000000000000000000000000000000000000001' }),
      deriveVoteSalt(KEY, { ...base, disputeId: 13n }),
      deriveVoteSalt(KEY, { ...base, round: 2 }),
      deriveVoteSalt(KEY, { ...base, juror: '0x0000000000000000000000000000000000000002' }),
      deriveVoteSalt(`0x${'43'.repeat(32)}`, base),
    ];
    expect(new Set([s, ...variants]).size).toBe(7);
  });

  it('match HMAC-SHA256 over the documented message (known-answer via openssl-independent recompute)', async () => {
    const { createHmac } = await import('node:crypto');
    const expect_ = `0x${createHmac('sha256', Buffer.from(KEY.slice(2), 'hex')).update(saltMessage(base)).digest('hex')}`;
    expect(saltMessage(base)).toBe(`envmarket.juror-vote-salt.v1|84532|${MARKET}|12|1|${JUROR.toLowerCase()}`);
    expect(deriveVoteSalt(KEY, base)).toBe(expect_);
  });

  it('recoverVerdict finds the committed verdict from the on-chain commitment alone', () => {
    const salt = deriveVoteSalt(KEY, base);
    for (const v of ['Uphold', 'Reject'] as const) {
      const c = commitmentOf({ disputeId: 12n, round: 1, verdict: v, salt, juror: JUROR });
      expect(recoverVerdict(c, { disputeId: 12n, round: 1, salt, juror: JUROR })).toBe(v);
      expect(recoverVerdict(c, { disputeId: 12n, round: 1, salt, juror: JUROR }, 'Reject')).toBe(v);
    }
    const foreign = commitmentOf({ disputeId: 12n, round: 1, verdict: 'Uphold', salt: `0x${'11'.repeat(32)}`, juror: JUROR });
    expect(recoverVerdict(foreign, { disputeId: 12n, round: 1, salt, juror: JUROR })).toBeNull();
  });
});

describe('commitment encoding (EnvMarket.commitmentFor)', () => {
  it('equals keccak256(abi.encode(uint256,uint8,uint8,bytes32,address)) computed independently with viem', () => {
    const salt = deriveVoteSalt(KEY, base);
    const manual = keccak256(encodeAbiParameters(parseAbiParameters('uint256, uint8, uint8, bytes32, address'), [12n, 1, 2, salt, JUROR]));
    expect(commitmentOf({ disputeId: 12n, round: 1, verdict: 'Reject', salt, juror: JUROR })).toBe(manual);
  });

  it.skipIf(!CAST)('matches cast abi-encode + keccak (Solidity abi.encode) for derived salts', () => {
    for (const [id, round, v] of [
      [1n, 1, 'Uphold'],
      [12n, 2, 'Reject'],
      [2n ** 200n, 1, 'Reject'],
    ] as const) {
      const salt = deriveVoteSalt(KEY, { ...base, disputeId: id, round });
      const enc = execFileSync(CAST!, ['abi-encode', 'f(uint256,uint8,uint8,bytes32,address)', id.toString(), String(round), String(VERDICT_CODE[v]), salt, JUROR], { encoding: 'utf8' }).trim();
      const want = execFileSync(CAST!, ['keccak', enc], { encoding: 'utf8' }).trim();
      expect(commitmentOf({ disputeId: id, round, verdict: v, salt, juror: JUROR })).toBe(want);
    }
  });
});

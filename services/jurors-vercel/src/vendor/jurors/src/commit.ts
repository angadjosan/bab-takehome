/**
 * Vote commitments. Must match EnvMarket.commitmentFor:
 *   keccak256(abi.encode(uint256 disputeId, uint8 round, uint8 verdict, bytes32 salt, address juror))
 */
import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';
import type { JurorStore, RoundRecord } from './state.ts';
import type { VerdictLabel } from './rubric.ts';

export const VERDICT_CODE: Record<VerdictLabel, 1 | 2> = { Uphold: 1, Reject: 2 };

export function newSalt(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

export function commitmentOf(a: { disputeId: bigint; round: number; verdict: VerdictLabel | 1 | 2; salt: Hex; juror: Address }): Hex {
  const code = typeof a.verdict === 'number' ? a.verdict : VERDICT_CODE[a.verdict];
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.salt)) throw new Error('salt must be bytes32');
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, uint8, uint8, bytes32, address'), [a.disputeId, a.round, code, a.salt, a.juror]),
  );
}

/**
 * Fix the vote secret for (dispute, round) and persist it durably BEFORE any commit tx is sent.
 * Idempotent: once a salt/verdict exist on disk they are returned unchanged (never regenerated),
 * so a restart re-sends the same commitment or reveals the persisted one.
 */
export function prepareCommit(
  store: JurorStore,
  disputeId: bigint,
  round: number,
  verdict: VerdictLabel,
  juror: Address,
): Required<Pick<RoundRecord, 'verdict' | 'salt' | 'commitment'>> {
  const rec = store.round(disputeId, round);
  if (rec.salt && rec.verdict && rec.commitment) {
    return { verdict: rec.verdict, salt: rec.salt, commitment: rec.commitment };
  }
  return store.update(() => {
    rec.verdict = verdict;
    rec.salt = newSalt();
    rec.commitment = commitmentOf({ disputeId, round, verdict, salt: rec.salt, juror });
    return { verdict: rec.verdict, salt: rec.salt, commitment: rec.commitment };
  });
}

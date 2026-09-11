/**
 * Vote salts, derived instead of stored.
 *
 *   salt = HMAC-SHA256(key = juror private key,
 *                      msg = "envmarket.juror-vote-salt.v1|<chainId>|<market>|<disputeId>|<round>|<juror>")
 *
 * The salt only has to be unpredictable to everyone else until the reveal, and never lost by us. An
 * HMAC under the juror's own key is both: nobody without the key can compute it, and any later run
 * (after a crash, a redeploy, or a lost workflow run) recomputes exactly the same value, so a
 * commitment on-chain can always be revealed. It never has to be written to a log, a database or
 * the workflow event log. Distinct per chain, market, dispute, round and juror. Revealing it on-chain
 * discloses nothing about the key (HMAC is a PRF).
 *
 * With only two possible verdicts, the verdict to reveal is recovered by recomputing the
 * commitment for both and matching the on-chain one (see recoverVerdict).
 */
import { createHmac } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { commitmentOf } from '../vendor/jurors/src/commit.ts';
import type { Verdict } from './types.ts';

export const SALT_DOMAIN = 'envmarket.juror-vote-salt.v1';

export function saltMessage(a: { chainId: number; market: Address; disputeId: bigint; round: number; juror: Address }): string {
  return [SALT_DOMAIN, a.chainId, a.market.toLowerCase(), a.disputeId.toString(), a.round, a.juror.toLowerCase()].join('|');
}

export function deriveVoteSalt(privateKey: Hex, a: { chainId: number; market: Address; disputeId: bigint; round: number; juror: Address }): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('deriveVoteSalt: bad key');
  const mac = createHmac('sha256', Buffer.from(privateKey.slice(2), 'hex')).update(saltMessage(a)).digest('hex');
  return `0x${mac}`;
}

/** The verdict whose commitment (with this salt) equals `onChain`, or null if neither does. */
export function recoverVerdict(onChain: Hex, a: { disputeId: bigint; round: number; salt: Hex; juror: Address }, preferred?: Verdict): Verdict | null {
  const order: Verdict[] = preferred === 'Reject' ? ['Reject', 'Uphold'] : ['Uphold', 'Reject'];
  for (const verdict of order) {
    if (commitmentOf({ ...a, verdict }).toLowerCase() === onChain.toLowerCase()) return verdict;
  }
  return null;
}

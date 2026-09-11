/**
 * In-memory EnvMarket dispute simulator for driver tests: mirrors the contract rules the jurors
 * depend on (selection after selectionBlock, commit window, reveal after commitDeadline or all
 * committed, AlreadyCommitted/AlreadyRevealed/CommitmentMismatch, tally by majority, round 2, the
 * NotEnoughJurors grace and no-quorum fallback, pull-payment claimable) and fakes the TEE/LLM.
 * Commitments use the real commitmentOf and the real derived salts.
 */
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveVoteSalt, recoverVerdict } from '../src/lib/salt.ts';
import { DisputeStatus, Ground, SEATS, ZERO32, type Action, type ActionResult, type Memory, type SeatSnap, type Snapshot, type Verdict } from '../src/lib/types.ts';
import { commitmentOf, VERDICT_CODE } from '../src/vendor/jurors/src/commit.ts';

export const KEYS: Record<number, Hex> = {
  1: `0x${'a1'.repeat(32)}`,
  2: `0x${'b2'.repeat(32)}`,
  3: `0x${'c3'.repeat(32)}`,
};
export const ADDR: Record<number, Address> = Object.fromEntries(Object.entries(KEYS).map(([i, k]) => [i, privateKeyToAccount(k).address])) as Record<number, Address>;
export const CHAIN_ID = 84532;
export const MARKET: Address = '0x2fd644342296df7de57929fa87bd65c05fb415f8';

export interface FakeOptions {
  verdicts?: Record<number, Verdict>;
  /** Juror indices seated in round 1 (default our three). Others are external addresses. */
  panel?: string[];
  /** Deliberation fails this many times first (per juror). */
  evidenceFailures?: Record<number, number>;
  /** External jurors' behaviour: commit+reveal this verdict, or never reveal. */
  external?: Record<string, Verdict | 'no-reveal'>;
  deliberationSeconds?: number;
  /** Eligible jurors besides the round-1 panel (for round 2). Default none. */
  spareJurors?: string[];
}

export class FakeMarket {
  block = 1000n;
  ts = 1_700_000_000n;
  status: number = DisputeStatus.AwaitingSelection;
  round = 1;
  verdict = 0;
  fallback = false;
  selectionBlock = 1002n;
  selectionDeadline = this.ts + 360n;
  commitDeadline = 0n;
  revealDeadline = 0n;
  seats: SeatSnap[] = Array.from({ length: 6 }, () => ({ juror: '0x0000000000000000000000000000000000000000', vote: 0, revealed: false, commitment: ZERO32 }));
  claimable: Record<string, bigint> = {};
  calls: Record<string, number> = {};
  txs: string[] = [];
  enabled = true;
  private evidenceLeft: Record<number, number>;

  constructor(readonly o: FakeOptions = {}) {
    this.evidenceLeft = { ...(o.evidenceFailures ?? {}) };
  }

  count(kind: string) {
    this.calls[kind] = (this.calls[kind] ?? 0) + 1;
  }

  advance(seconds: number) {
    this.ts += BigInt(Math.ceil(seconds));
    this.block += BigInt(Math.ceil(seconds / 2));
    // external jurors act as soon as they can
    const panel = this.panel();
    for (const s of panel) {
      const ext = this.o.external?.[s.juror];
      if (!ext || this.status !== DisputeStatus.Voting) continue;
      if (s.commitment === ZERO32 && this.ts <= this.commitDeadline) s.commitment = `0x${'ee'.repeat(32)}`;
      if (ext !== 'no-reveal' && !s.revealed && s.commitment !== ZERO32 && this.revealOpen()) {
        s.revealed = true;
        s.vote = VERDICT_CODE[ext];
      }
    }
  }

  panel(): SeatSnap[] {
    return this.seats.slice((this.round - 1) * SEATS, this.round * SEATS);
  }
  allCommitted() {
    return this.panel().every((s) => s.commitment !== ZERO32);
  }
  revealOpen() {
    return (this.ts > this.commitDeadline || this.allCommitted()) && this.ts <= this.revealDeadline;
  }

  snapshot = async (disputeId: string): Promise<Snapshot> => {
    this.count('snapshot');
    return {
      disputeId,
      head: { number: this.block, timestamp: this.ts },
      enabled: this.enabled,
      keeperIndex: 1,
      dispute: {
        purchaseId: 1n,
        ground: Ground.FalseDescription,
        status: this.status,
        verdict: this.verdict,
        round: this.round,
        fallbackNoQuorum: this.fallback,
        selectionBlock: this.selectionBlock,
        selectionDeadline: this.selectionDeadline,
        commitDeadline: this.commitDeadline,
        revealDeadline: this.revealDeadline,
      },
      seats: this.seats.map((s) => ({ ...s })),
      jurors: [1, 2, 3].map((i) => ({ index: i, address: ADDR[i]!, claimable: this.claimable[ADDR[i]!.toLowerCase()] ?? 0n })),
    };
  };

  sleep = async (seconds: number) => {
    this.count('sleep');
    this.advance(seconds);
  };

  private seatOf(i: number, round = this.round) {
    return this.seats.slice((round - 1) * SEATS, round * SEATS).find((s) => s.juror.toLowerCase() === ADDR[i]!.toLowerCase());
  }

  private tx(kind: Action['kind'], i: number): Hex {
    this.txs.push(`${kind}:${i}`);
    this.advance(2);
    return `0x${this.txs.length.toString(16).padStart(64, '0')}`;
  }

  private armSelection() {
    this.selectionBlock = this.block + 2n;
    this.selectionDeadline = this.ts + 360n;
  }

  private failRound() {
    if (this.round === 1) {
      this.round = 2;
      this.status = DisputeStatus.AwaitingSelection;
      this.commitDeadline = 0n;
      this.revealDeadline = 0n;
      this.armSelection();
    } else {
      this.status = DisputeStatus.Resolved;
      this.fallback = true;
    }
  }

  execute = async (disputeId: string, a: Action, mem: Memory): Promise<ActionResult> => {
    this.count(a.kind);
    const salt = (i: number, round: number) => deriveVoteSalt(KEYS[i]!, { chainId: CHAIN_ID, market: MARKET, disputeId: BigInt(disputeId), round, juror: ADDR[i]! });
    switch (a.kind) {
      case 'select': {
        if (this.status !== DisputeStatus.AwaitingSelection) return { ok: false, kind: a.kind, reason: 'WrongState', retryable: true };
        if (this.block <= this.selectionBlock) return { ok: false, kind: a.kind, reason: 'TooEarly', retryable: true };
        const r1 = this.o.panel ?? [ADDR[1]!, ADDR[2]!, ADDR[3]!];
        let panel: string[];
        if (this.round === 1) panel = r1;
        else {
          const spare = this.o.spareJurors ?? [];
          if (spare.length < 3) {
            if (this.ts <= this.selectionDeadline) return { ok: false, kind: a.kind, reason: 'NotEnoughJurors', retryable: true };
            this.failRound();
            return { ok: true, kind: a.kind, hash: this.tx('select', a.jurorIndex), note: 'round failed: no panel' };
          }
          panel = spare.slice(0, 3);
        }
        const base = (this.round - 1) * SEATS;
        panel.forEach((j, k) => (this.seats[base + k] = { juror: j, vote: 0, revealed: false, commitment: ZERO32 }));
        this.status = DisputeStatus.Voting;
        this.commitDeadline = this.ts + 180n;
        this.revealDeadline = this.commitDeadline + 180n;
        return { ok: true, kind: a.kind, hash: this.tx('select', a.jurorIndex) };
      }
      case 'deliberate': {
        if ((this.evidenceLeft[a.jurorIndex] ?? 0) > 0) {
          this.evidenceLeft[a.jurorIndex]!--;
          this.advance(1);
          return { ok: false, kind: a.kind, reason: 'evidence not available yet: HTTP 404', retryable: true };
        }
        this.advance(this.o.deliberationSeconds ?? 20);
        const verdict = this.o.verdicts?.[a.jurorIndex] ?? 'Uphold';
        return { ok: true, kind: a.kind, decision: { verdict, decision: { output: { verdict } } } };
      }
      case 'prepare': {
        const commitment = commitmentOf({ disputeId: BigInt(disputeId), round: a.round, verdict: a.verdict, salt: salt(a.jurorIndex, a.round), juror: ADDR[a.jurorIndex]! });
        return { ok: true, kind: a.kind, verdict: a.verdict, commitment };
      }
      case 'commit': {
        const seat = this.seatOf(a.jurorIndex, a.round);
        if (!seat) return { ok: false, kind: a.kind, reason: 'NotSeated', retryable: false };
        if (this.ts > this.commitDeadline) return { ok: false, kind: a.kind, reason: 'DeadlinePassed', retryable: false };
        if (seat.commitment !== ZERO32) throw new Error('AlreadyCommitted: the driver sent a second commit');
        seat.commitment = a.commitment;
        return { ok: true, kind: a.kind, hash: this.tx('commit', a.jurorIndex) };
      }
      case 'reveal': {
        const seat = this.seatOf(a.jurorIndex, a.round)!;
        if (!this.revealOpen()) return { ok: false, kind: a.kind, reason: 'TooEarly', retryable: true };
        if (seat.revealed) throw new Error('AlreadyRevealed: the driver sent a second reveal');
        const v = recoverVerdict(seat.commitment, { disputeId: BigInt(disputeId), round: a.round, salt: salt(a.jurorIndex, a.round), juror: ADDR[a.jurorIndex]! }, a.verdict);
        if (!v) return { ok: false, kind: a.kind, reason: 'CommitmentMismatch', retryable: false };
        seat.revealed = true;
        seat.vote = VERDICT_CODE[v];
        return { ok: true, kind: a.kind, hash: this.tx('reveal', a.jurorIndex), verdict: v };
      }
      case 'publish':
        if (!mem.decisions[`${a.jurorIndex}:${a.round}`]) return { ok: false, kind: a.kind, reason: 'no decision', retryable: false };
        return { ok: true, kind: a.kind, sha256: `0x${'5'.repeat(64)}` };
      case 'tally': {
        if (this.status !== DisputeStatus.Voting) return { ok: false, kind: a.kind, reason: 'WrongState', retryable: true };
        const panel = this.panel();
        const reveals = panel.filter((s) => s.revealed);
        if (this.ts <= this.revealDeadline && reveals.length < 3) return { ok: false, kind: a.kind, reason: 'TooEarly', retryable: true };
        const ups = reveals.filter((s) => s.vote === 1).length;
        const rejects = reveals.length - ups;
        if (reveals.length >= 2 && ups !== rejects) {
          this.status = DisputeStatus.Resolved;
          this.verdict = ups > rejects ? 1 : 2;
          for (const s of reveals) if (s.vote === this.verdict) this.claimable[s.juror.toLowerCase()] = (this.claimable[s.juror.toLowerCase()] ?? 0n) + 3_000_000n;
        } else {
          this.failRound();
        }
        return { ok: true, kind: a.kind, hash: this.tx('tally', a.jurorIndex) };
      }
      case 'withdraw': {
        const k = ADDR[a.jurorIndex]!.toLowerCase();
        if (!this.claimable[k]) return { ok: true, kind: a.kind, note: 'nothing to withdraw' };
        this.claimable[k] = 0n;
        return { ok: true, kind: a.kind, hash: this.tx('withdraw', a.jurorIndex) };
      }
    }
  };
}

/**
 * Plain, serializable data passed between the workflow (sandboxed, deterministic) and its steps.
 * Pure module: no Node.js imports (it is part of the workflow bundle).
 */
export type Hex = `0x${string}`;
export type Verdict = 'Uphold' | 'Reject';

/** Solidity enum mirrors (packages/shared/src/enums.ts). */
export const Ground = { None: 0, BrokenOrHashMismatch: 1, FalseDescription: 2, PreviewNotReproducible: 3 } as const;
export const DisputeStatus = { None: 0, AwaitingSelection: 1, Voting: 2, Resolved: 3 } as const;
export const VerdictCode = { None: 0, Uphold: 1, Reject: 2 } as const;
export const SEATS = 3;
export const ZERO32: Hex = `0x${'0'.repeat(64)}`;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SeatSnap {
  juror: string;
  vote: number;
  revealed: boolean;
  commitment: Hex;
}

export interface DisputeSnap {
  purchaseId: bigint;
  ground: number;
  status: number;
  verdict: number;
  round: number;
  fallbackNoQuorum: boolean;
  selectionBlock: bigint;
  selectionDeadline: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
}

export interface OurJuror {
  index: number;
  address: string;
  claimable: bigint;
}

/** One chain read per loop iteration (the chain is the source of truth for every decision). */
export interface Snapshot {
  disputeId: string;
  head: { number: bigint; timestamp: bigint };
  enabled: boolean;
  dispute: DisputeSnap;
  seats: SeatSnap[];
  jurors: OurJuror[];
  keeperIndex: number;
}

/** A deliberation outcome (the vendored services/jurors Decision, kept opaque here). */
export interface DecisionRecord {
  verdict: Verdict;
  /** services/jurors `Decision` (screened public rationale, model ids, prompt hash, packet hash). */
  decision: unknown;
}

export type Action =
  | { kind: 'select'; round: number; jurorIndex: number }
  | { kind: 'deliberate'; round: number; jurorIndex: number; commitDeadline: bigint }
  | { kind: 'prepare'; round: number; jurorIndex: number; verdict: Verdict }
  | { kind: 'commit'; round: number; jurorIndex: number; verdict: Verdict; commitment: Hex }
  | { kind: 'reveal'; round: number; jurorIndex: number; verdict?: Verdict }
  | { kind: 'publish'; round: number; jurorIndex: number }
  | { kind: 'tally'; round: number; jurorIndex: number }
  | { kind: 'withdraw'; jurorIndex: number };

/** Result of executing one action (always returned, never thrown, so the loop keeps going). */
export type ActionResult =
  | { ok: true; kind: Action['kind']; hash?: Hex; note?: string; decision?: DecisionRecord; commitment?: Hex; sha256?: Hex; verdict?: Verdict }
  | { ok: false; kind: Action['kind']; reason: string; retryable: boolean };

export type Plan =
  | { kind: 'act'; actions: Action[]; note: string }
  | { kind: 'wait'; seconds: number; note: string }
  | { kind: 'done'; outcome: string };

/** Workflow memory: everything learned from step results (replayed deterministically). */
export interface Memory {
  decisions: Record<string, DecisionRecord>;
  /** Failed deliberations per juror/round (evidence not ready, model error). */
  deliberationFailures: Record<string, number>;
  prepared: Record<string, { verdict: Verdict; commitment: Hex }>;
  revealTx: Record<string, Hex>;
  published: Record<string, Hex>;
  publishFailures: Record<string, number>;
  /** Last keeper outcome per "select:<round>:<selectionBlock>" / "tally:<round>". */
  keeper: Record<string, { ok: boolean; reason?: string; at: bigint }>;
  withdrawn: Record<string, Hex>;
  /** Other failure counters, e.g. "withdraw:<jurorIndex>". */
  failures: Record<string, number>;
  /** Human-readable trail of what happened (returned as the run result). */
  log: string[];
}

export const key = (jurorIndex: number, round: number): string => `${jurorIndex}:${round}`;

export function emptyMemory(): Memory {
  return { decisions: {}, deliberationFailures: {}, prepared: {}, revealTx: {}, published: {}, publishFailures: {}, keeper: {}, withdrawn: {}, failures: {}, log: [] };
}

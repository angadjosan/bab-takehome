/** Solidity enum mirrors (order matters) and token units. */
import { formatUnits, parseUnits } from 'viem';

export const PurchaseState = { None: 0, Funded: 1, Delivered: 2, Disputed: 3, Refunded: 4, Settled: 5 } as const;
export const Ground = { None: 0, BrokenOrHashMismatch: 1, FalseDescription: 2, PreviewNotReproducible: 3 } as const;
export const DisputeStatus = { None: 0, AwaitingSelection: 1, Voting: 2, Resolved: 3 } as const;
export const Verdict = { None: 0, Uphold: 1, Reject: 2 } as const;

export type PurchaseStateName = keyof typeof PurchaseState;
export type GroundName = keyof typeof Ground;
export type DisputeStatusName = keyof typeof DisputeStatus;
export type VerdictName = keyof typeof Verdict;

/** Reverse lookup: enumName(Ground, 2) === 'FalseDescription'. */
export function enumName<T extends Record<string, number>>(e: T, value: number | bigint): keyof T {
  const n = Number(value);
  const k = Object.keys(e).find((key) => e[key] === n);
  if (k === undefined) throw new RangeError(`unknown enum value ${n}`);
  return k as keyof T;
}

export const MECHANICAL_GROUNDS: readonly number[] = [Ground.BrokenOrHashMismatch, Ground.PreviewNotReproducible];

export const TUSDC_DECIMALS = 6;
export const TUSDC_SYMBOL = 'tUSDC';

/** "100" -> 100_000_000n */
export function parseTusdc(amount: string | number): bigint {
  return parseUnits(String(amount), TUSDC_DECIMALS);
}
/** 100_000_000n -> "100" */
export function formatTusdc(amount: bigint): string {
  return formatUnits(amount, TUSDC_DECIMALS);
}

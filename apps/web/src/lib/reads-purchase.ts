"use client";

import { useQuery } from "@tanstack/react-query";
import { deployment } from "./config";
import { readOptional } from "./market";

const on = !!deployment;

/** Jurors seated per round: EnvMarket's `seats()` view (the SEATS constant). */
export async function fetchSeatsPerRound(): Promise<number> {
  const v = (await readOptional("seats")) ?? (await readOptional("SEATS"));
  if (v === undefined) throw new Error("The market contract doesn’t report its jury size (seats()).");
  return Number(v);
}

export function useSeatsPerRound() {
  return useQuery({ queryKey: ["seats-per-round"], queryFn: fetchSeatsPerRound, enabled: on, staleTime: Infinity });
}

/** (requested refund, bond) the contract would set for a dispute over `taskMask`: EnvMarket's `quoteDispute` view. */
export async function fetchDisputeQuote(purchaseId: bigint, taskMask: bigint): Promise<{ requested: bigint; bond: bigint }> {
  const r = await readOptional("quoteDispute", [purchaseId, taskMask]);
  if (!Array.isArray(r)) throw new Error("The market contract didn’t return a dispute quote.");
  return { requested: BigInt(r[0] as bigint), bond: BigInt(r[1] as bigint) };
}

export function useDisputeQuote(purchaseId: bigint, taskMask: bigint) {
  return useQuery({
    queryKey: ["dispute-quote", purchaseId.toString(), taskMask.toString()],
    queryFn: () => fetchDisputeQuote(purchaseId, taskMask),
    enabled: on,
    placeholderData: (prev) => prev,
  });
}

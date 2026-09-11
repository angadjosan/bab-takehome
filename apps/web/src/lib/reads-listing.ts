"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { deployment } from "./config";
import { readOptional } from "./market";

/** EnvMarket.qualifyingTxThreshold(): settled sales a seller needs before it counts as established. */
export function useQualifyThreshold() {
  return useQuery({
    queryKey: ["qualifyingTxThreshold"],
    enabled: !!deployment,
    staleTime: Infinity,
    queryFn: async () => {
      const v = (await readOptional("qualifyingTxThreshold")) ?? (await readOptional("QUALIFYING_TX_THRESHOLD"));
      return v === undefined ? null : BigInt(v as bigint);
    },
  });
}

export type Eip712Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

let domain: Promise<Eip712Domain | null> | null = null;

/** EnvMarket.eip712Domain() (ERC-5267): the domain its signatures are checked under. */
export function fetchEip712Domain(): Promise<Eip712Domain | null> {
  domain ??= readOptional("eip712Domain").then((r) => {
    if (!Array.isArray(r)) return null;
    const [, name, version, chainId, verifyingContract] = r as [unknown, string, string, bigint, Address];
    return { name, version, chainId: Number(chainId), verifyingContract };
  });
  return domain;
}

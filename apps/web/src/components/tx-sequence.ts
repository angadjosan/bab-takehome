"use client";

import { useState } from "react";
import type { Abi, Address } from "viem";
import { useAccount } from "wagmi";
import { tokenAbi } from "@/lib/abi";
import { publicClient } from "@/lib/client";
import { deployment } from "@/lib/config";
import { useTx } from "./tx";

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/**
 * One user action for anything that pulls tokens into the market (buy, dispute bond, collateral,
 * juror stake, preview fee): approve the exact amount first only if the allowance is short, then make
 * the call. One button, one progress line ("1/2 approve", "2/2 …"); queries refresh after each step.
 */
export function useApproveAndCall() {
  const { address } = useAccount();
  const tx = useTx();
  const [step, setStep] = useState<string | null>(null);

  async function run(label: string, amount: bigint, call: Call) {
    if (!address || !deployment) return null;
    try {
      const allowance = (await publicClient.readContract({ address: deployment.token, abi: tokenAbi, functionName: "allowance", args: [address, deployment.market] })) as bigint;
      if (amount > 0n && allowance < amount) {
        setStep("1/2");
        const approved = await tx.run(`${label} · step 1 of 2 (allow the payment)`, { address: deployment.token, abi: tokenAbi, functionName: "approve", args: [deployment.market, amount] });
        if (!approved) return null;
        setStep("2/2");
        return await tx.run(`${label} · step 2 of 2`, call);
      }
      setStep("1/1");
      return await tx.run(label, call);
    } finally {
      setStep(null);
    }
  }

  return { run, state: tx.state, busy: tx.busy || step !== null, step, reset: tx.reset };
}

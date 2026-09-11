"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type TransactionReceipt } from "viem";
import { useAccount, useChainId, useConnect, useSwitchChain, useWriteContract } from "wagmi";
import { publicClient } from "@/lib/client";
import { CHAIN_ID, CHAIN_NAME } from "@/lib/config";
import { ErrorText, Spinner, TxLink } from "./ui";

export type TxState = { status: "idle" | "simulating" | "signing" | "pending" | "success" | "error"; hash?: `0x${string}`; error?: unknown; receipt?: TransactionReceipt; label?: string };

export function friendlyError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert?.data?.errorName) {
      const args = revert.data.args?.length ? `(${revert.data.args.map(String).join(", ")})` : "";
      return `Contract reverted: ${revert.data.errorName}${args}`;
    }
    if (/User rejected|denied/i.test(e.message)) return "Transaction rejected in wallet.";
    return e.shortMessage || e.message;
  }
  return (e as Error)?.message ?? String(e);
}

/** simulate → sign → wait for receipt, with query invalidation afterwards. */
export function useTx() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  async function run(label: string, p: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) {
    setState({ status: "simulating", label });
    try {
      const sim = await publicClient.simulateContract({ ...p, account: address } as never);
      setState({ status: "signing", label });
      const hash = await writeContractAsync((sim as unknown as { request: never }).request);
      setState({ status: "pending", hash, label });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");
      setState({ status: "success", hash, receipt, label });
      await qc.invalidateQueries();
      return receipt;
    } catch (error) {
      setState((s) => ({ status: "error", hash: s.hash, error, label }));
      return null;
    }
  }
  const busy = state.status === "simulating" || state.status === "signing" || state.status === "pending";
  return { state, run, busy, reset: () => setState({ status: "idle" }) };
}

export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  const text = {
    simulating: "Checking the transaction against the contract…",
    signing: "Confirm in your wallet…",
    pending: "Waiting for confirmation…",
    success: "Confirmed",
    error: "",
  }[state.status as "simulating"];
  return (
    <div className="mt-2 text-xs">
      {state.status === "error" ? (
        <>
          <ErrorText error={{ message: friendlyError(state.error) }} />
          {state.hash && <TxLink hash={state.hash} label="view transaction" />}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-muted">
          {state.status !== "success" ? <Spinner className="h-3.5 w-3.5" /> : <span className="text-ok">✓</span>}
          <span>{state.label ? `${state.label}: ` : ""}{text}</span>
          {state.hash && <TxLink hash={state.hash} />}
        </div>
      )}
    </div>
  );
}

/** Renders children only when a wallet is connected to the right chain; otherwise a prompt. */
export function RequireWallet({ children, why }: { children: ReactNode; why?: string }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  if (!isConnected) {
    const uniq = connectors.filter((c, i, arr) => arr.findIndex((x) => x.name === c.name) === i);
    return (
      <div className="rounded-lg border border-dashed border-line-strong p-4 text-sm">
        <p className="text-muted">{why ?? "Connect a wallet to continue."}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {uniq.map((c) => (
            <button key={c.uid} className="btn btn-sm" disabled={isPending} onClick={() => connect({ connector: c, chainId: CHAIN_ID })}>
              {c.name === "Injected" ? "Browser wallet" : c.name}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (chainId !== CHAIN_ID) {
    return (
      <div className="rounded-lg border border-dashed border-warn p-4 text-sm">
        <p className="text-warn">Your wallet is on chain {chainId}. This market lives on {CHAIN_NAME}.</p>
        <button className="btn btn-sm mt-3" disabled={switching} onClick={() => switchChain({ chainId: CHAIN_ID })}>
          Switch to {CHAIN_NAME}
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";
import { tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { requestFaucet } from "@/lib/faucet-client";
import { TxStatus, useTx, type TxState } from "./tx";
import { ErrorText, IconCheck, Spinner, TxLink } from "./ui";

export type FaucetState =
  | { status: "idle" | "pending" }
  | { status: "success"; message: string; ethTx?: `0x${string}`; tokenTx?: `0x${string}` }
  | { status: "funded"; message: string }
  | { status: "error"; error: string }
  | { status: "tx"; tx: TxState };

/**
 * "Get test funds": asks the server faucet (/api/faucet) to send the connected wallet the payment
 * token plus a little ETH for fees, so new embedded wallets never need gas to get started. If this
 * server has no faucet wallet configured (local anvil), it falls back to the token's own `faucet()`
 * sent from the user's wallet. `run` ignores its arguments so it drops into existing useTx call sites.
 */
export function useFaucet() {
  const { address } = useAccount();
  const qc = useQueryClient();
  const tx = useTx();
  const [state, setState] = useState<FaucetState>({ status: "idle" });

  async function run(..._ignored: unknown[]) {
    void _ignored;
    if (!address) return;
    setState({ status: "pending" });
    const { status, body } = await requestFaucet(address);
    if (body?.ok) {
      setState(body.status === "funded" ? { status: "funded", message: body.message } : { status: "success", message: body.message, ethTx: body.ethTx, tokenTx: body.tokenTx });
      await qc.invalidateQueries();
      return;
    }
    if (body?.code === "unconfigured" && deployment) {
      setState({ status: "tx", tx: { status: "idle" } });
      await tx.run("Faucet", { address: deployment.token, abi: tokenAbi, functionName: "faucet" });
      return;
    }
    setState({ status: "error", error: body?.error ?? (status ? `The faucet returned ${status}.` : "The faucet could not be reached.") });
  }

  const shown: FaucetState = state.status === "tx" ? { status: "tx", tx: tx.state } : state;
  const busy = state.status === "pending" || tx.busy;
  return { state: shown, run, busy, reset: () => setState({ status: "idle" }) };
}

export function FaucetStatus({ state }: { state: FaucetState }) {
  if (state.status === "idle") return null;
  if (state.status === "tx") return <TxStatus state={state.tx} />;
  if (state.status === "error")
    return (
      <div className="mt-2 text-xs">
        <ErrorText error={{ message: state.error }} />
      </div>
    );
  return (
    <div className="mt-2 text-xs text-muted" role="status">
      <div className="flex flex-wrap items-center gap-2">
        {state.status === "pending" ? <Spinner className="h-3.5 w-3.5" /> : <IconCheck className="h-3.5 w-3.5 text-ok" />}
        <span>{"message" in state ? state.message : "Sending test funds…"}</span>
      </div>
      {state.status === "success" && (state.ethTx || state.tokenTx) && (
        <details className="mt-1">
          <summary className="cursor-pointer hover:text-ink">Details</summary>
          <div className="mt-1 flex flex-col gap-1">
            {state.tokenTx && <TxLink hash={state.tokenTx} label="Token transfer" />}
            {state.ethTx && <TxLink hash={state.ethTx} label="Fee ETH transfer" />}
          </div>
        </details>
      )}
    </div>
  );
}

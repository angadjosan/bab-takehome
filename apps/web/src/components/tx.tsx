"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useContext, useState, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { useAccount, useChainId, useConnect, useSwitchChain, useWriteContract } from "wagmi";
import { BURNER_CONNECTOR_ID } from "@/lib/burner";
import { publicClient } from "@/lib/client";
import { CHAIN_ID, CHAIN_NAME } from "@/lib/config";
import { SponsorCtx } from "@/lib/sponsor";
import { BurnerForm, BurnerSwitcher } from "./burner-ui";
import { PrivyLoginPrompt } from "./privy-login";
import { useWalletMode } from "./providers";
import { ErrorText, Spinner, TxLink } from "./ui";

export type TxState = { status: "idle" | "simulating" | "signing" | "pending" | "success" | "error"; hash?: `0x${string}`; error?: unknown; receipt?: TransactionReceipt; label?: string; sponsored?: boolean };

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

/**
 * simulate → sign → wait for receipt, with query invalidation afterwards. Writes from a Privy
 * embedded wallet go through Privy's sponsored sender when gas sponsorship is on; every other
 * account signs through wagmi (browser wallet, Privy wallet without sponsorship, burner key).
 */
export function useTx() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const sponsor = useContext(SponsorCtx);
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  async function run(label: string, p: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) {
    setState({ status: "simulating", label });
    try {
      // simulation surfaces revert reasons before the user is asked to sign anything
      const sim = await publicClient.simulateContract({ ...p, account: address } as never);
      const sponsored = !!sponsor && !!address && sponsor.canSponsor(address);
      setState({ status: "signing", label, sponsored });
      let hash: Hex;
      if (sponsored) {
        const data = encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args } as never);
        hash = await sponsor!.send({ to: p.address, data }, address!);
      } else {
        hash = await writeContractAsync((sim as unknown as { request: never }).request);
      }
      setState({ status: "pending", hash, label, sponsored });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain");
      setState({ status: "success", hash, receipt, label, sponsored });
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
          <span>
            {state.label ? `${state.label}: ` : ""}
            {text}
            {state.sponsored ? " (gas sponsored)" : ""}
          </span>
          {state.hash && <TxLink hash={state.hash} />}
        </div>
      )}
    </div>
  );
}

/** Renders children only when a wallet is connected to the right chain; otherwise a login/connect prompt. */
export function RequireWallet({ children, why }: { children: ReactNode; why?: string }) {
  const { mode } = useWalletMode();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  if (!isConnected) return mode === "privy" ? <PrivyLoginPrompt why={why} /> : <ConnectPrompt why={why} />;
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

/** wagmi mode (dev tools, or Privy not configured): browser wallets, plus burner keys with dev tools on. */
function ConnectPrompt({ why }: { why?: string }) {
  const { devTools } = useWalletMode();
  const { connectors, connect, isPending } = useConnect();
  const [burnerOpen, setBurnerOpen] = useState(false);
  const uniq = connectors.filter((c, i, arr) => c.id !== BURNER_CONNECTOR_ID && arr.findIndex((x) => x.name === c.name) === i);
  return (
    <div className="rounded-lg border border-dashed border-line-strong p-4 text-sm">
      <p className="text-muted">{why ?? "Connect a wallet to continue."}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {uniq.map((c) => (
          <button key={c.uid} className="btn btn-sm" disabled={isPending} onClick={() => connect({ connector: c, chainId: CHAIN_ID })}>
            {c.name === "Injected" ? "Browser wallet" : c.name}
          </button>
        ))}
        {devTools && (
          <button className="btn btn-sm" onClick={() => setBurnerOpen((x) => !x)}>
            Use a burner key (dev)
          </button>
        )}
      </div>
      {devTools && burnerOpen && (
        <div className="mt-3 space-y-3">
          <BurnerSwitcher />
          <BurnerForm />
        </div>
      )}
    </div>
  );
}

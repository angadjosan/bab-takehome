"use client";

import { useState } from "react";
import { parseUnits, type Abi, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { useTokenInfo } from "./providers";
import { TxStatus, useTx } from "./tx";

export function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  try {
    const v = parseUnits(t, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Amount input → exact-amount token approval (if needed) → contract call that pulls the tokens.
 * Used for seller collateral and juror stake deposits.
 */
export function DepositAction({ label, functionName, max, hint }: { label: string; functionName: string; max?: bigint; hint?: string }) {
  const { address } = useAccount();
  const token = useTokenInfo();
  const [amt, setAmt] = useState("");
  const approve = useTx();
  const call = useTx();
  const market = deployment!.market;
  const amount = parseAmount(amt, token.decimals);
  const allowance = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "allowance", args: [address!, market], query: { enabled: !!address, refetchInterval: 6_000 } });
  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { enabled: !!address, refetchInterval: 6_000 } });
  const balance = bal.data as bigint | undefined;
  const approved = amount !== null && ((allowance.data as bigint | undefined) ?? 0n) >= amount;
  const enough = amount !== null && balance !== undefined && balance >= amount && (max === undefined || amount <= max);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-36 tabular-nums" inputMode="decimal" placeholder={`amount (${token.symbol})`} value={amt} onChange={(e) => setAmt(e.target.value)} />
        {!approved ? (
          <button
            className="btn btn-sm"
            disabled={!enough || approve.busy}
            onClick={() => approve.run("Approve", { address: deployment!.token, abi: tokenAbi, functionName: "approve", args: [market, amount!] })}
          >
            Approve {amount ? fmtUsdc(amount) : ""}
          </button>
        ) : (
          <span className="badge badge-ok">approved</span>
        )}
        <button
          className="btn btn-primary btn-sm"
          disabled={!approved || !enough || call.busy}
          onClick={async () => {
            if (await call.run(label, { address: market, abi: (await import("@/lib/abi")).marketAbi as Abi, functionName, args: [amount!] })) setAmt("");
          }}
        >
          {label}
        </button>
      </div>
      <p className="text-[11px] text-muted">
        Wallet: {balance === undefined ? "…" : fmtUsdc(balance)}
        {hint ? ` · ${hint}` : ""}
      </p>
      <TxStatus state={approve.state} />
      <TxStatus state={call.state} />
    </div>
  );
}

/** Amount input → a contract call that sends tokens back (withdrawals capped at `max`). */
export function WithdrawAction({ label, functionName, max }: { label: string; functionName: string; max: bigint }) {
  const token = useTokenInfo();
  const [amt, setAmt] = useState("");
  const tx = useTx();
  const amount = parseAmount(amt, token.decimals);
  const ok = amount !== null && amount <= max;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-36 tabular-nums" inputMode="decimal" placeholder={`amount (${token.symbol})`} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <button className="btn btn-sm" disabled={max === 0n} onClick={() => setAmt((Number(max) / 10 ** token.decimals).toString())}>
          max {fmtUsdc(max, { symbol: false })}
        </button>
        <button
          className="btn btn-sm"
          disabled={!ok || tx.busy}
          onClick={async () => {
            const { marketAbi } = await import("@/lib/abi");
            if (await tx.run(label, { address: deployment!.market as Address, abi: marketAbi, functionName, args: [amount!] })) setAmt("");
          }}
        >
          {label}
        </button>
      </div>
      <TxStatus state={tx.state} />
    </div>
  );
}

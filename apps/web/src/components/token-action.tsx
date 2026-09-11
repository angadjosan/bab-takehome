"use client";

import { useState } from "react";
import { parseUnits, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { useTokenInfo } from "./providers";
import { TxStatus, useTx } from "./tx";
import { useApproveAndCall } from "./tx-sequence";

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
 * Amount input + one button that moves tokens into the market (seller collateral, juror stake): the
 * exact amount is approved first only if the allowance is short, then the deposit call is sent.
 */
export function DepositAction({ label, functionName, max, hint }: { label: string; functionName: string; max?: bigint; hint?: string }) {
  const { address } = useAccount();
  const token = useTokenInfo();
  const [amt, setAmt] = useState("");
  const seq = useApproveAndCall();
  const amount = parseAmount(amt, token.decimals);
  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { enabled: !!address, refetchInterval: 6_000 } });
  const balance = bal.data as bigint | undefined;
  const enough = amount !== null && balance !== undefined && balance >= amount && (max === undefined || amount <= max);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-36 tabular-nums" inputMode="decimal" placeholder={`amount (${token.symbol})`} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <button
          className="btn btn-primary btn-sm"
          disabled={!enough || seq.busy}
          onClick={async () => {
            if (await seq.run(label, amount!, { address: deployment!.market, abi: marketAbi, functionName, args: [amount!] })) setAmt("");
          }}
        >
          {label}
        </button>
      </div>
      <p className="text-[11px] text-muted">
        Wallet: {balance === undefined ? "…" : fmtUsdc(balance)}
        {hint ? ` · ${hint}` : ""}
      </p>
      <TxStatus state={seq.state} />
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

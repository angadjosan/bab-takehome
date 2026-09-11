"use client";

import { useId, useState } from "react";
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

function AmountInput({ id, name, label, value, onChange, symbol }: { id: string; name: string; label: string; value: string; onChange: (v: string) => void; symbol: string }) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        name={name}
        className="input w-40 font-mono tabular-nums"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder={`Amount in ${symbol}…`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

/**
 * Amount input + one button that moves tokens into the market (seller collateral, juror stake): the
 * exact amount is approved first only if the allowance is short, then the deposit call is sent.
 */
export function DepositAction({ label, functionName, max, hint }: { label: string; functionName: string; max?: bigint; hint?: string }) {
  const { address } = useAccount();
  const token = useTokenInfo();
  const id = useId();
  const [amt, setAmt] = useState("");
  const seq = useApproveAndCall();
  const amount = parseAmount(amt, token.decimals);
  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { enabled: !!address, refetchInterval: 6_000 } });
  const balance = bal.data as bigint | undefined;
  const enough = amount !== null && balance !== undefined && balance >= amount && (max === undefined || amount <= max);
  const short = amount !== null && balance !== undefined && balance < amount;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AmountInput id={id} name={`${functionName}-amount`} label={`${label} amount in ${token.symbol}`} value={amt} onChange={setAmt} symbol={token.symbol} />
        <button
          className="btn btn-primary"
          disabled={!enough || seq.busy}
          onClick={async () => {
            if (await seq.run(label, amount!, { address: deployment!.market, abi: marketAbi, functionName, args: [amount!] })) setAmt("");
          }}
        >
          {seq.busy ? `${label}…` : amount ? `${label} ${fmtUsdc(amount)}` : label}
        </button>
      </div>
      <p className={short ? "text-xs text-warn" : "text-xs text-muted"}>
        {short ? "More than your wallet holds. " : ""}In your wallet: <span className="font-mono tabular-nums">{balance === undefined ? "…" : fmtUsdc(balance)}</span>
        {hint ? ` · ${hint}` : ""}
      </p>
      <div aria-live="polite">
        <TxStatus state={seq.state} />
      </div>
    </div>
  );
}

/** Amount input → a contract call that sends tokens back (withdrawals capped at `max`). */
export function WithdrawAction({ label, functionName, max }: { label: string; functionName: string; max: bigint }) {
  const token = useTokenInfo();
  const id = useId();
  const [amt, setAmt] = useState("");
  const tx = useTx();
  const amount = parseAmount(amt, token.decimals);
  const ok = amount !== null && amount <= max;
  const over = amount !== null && amount > max;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AmountInput id={id} name={`${functionName}-amount`} label={`${label} amount in ${token.symbol}`} value={amt} onChange={setAmt} symbol={token.symbol} />
        <button className="btn btn-ghost btn-sm" disabled={max === 0n} onClick={() => setAmt((Number(max) / 10 ** token.decimals).toString())} aria-label={`Use the maximum, ${fmtUsdc(max)}`}>
          Max
        </button>
        <button
          className="btn"
          disabled={!ok || tx.busy}
          onClick={async () => {
            if (await tx.run(label, { address: deployment!.market as Address, abi: marketAbi, functionName, args: [amount!] })) setAmt("");
          }}
        >
          {tx.busy ? `${label}…` : label}
        </button>
      </div>
      <p className={over ? "text-xs text-warn" : "text-xs text-muted"}>
        {over ? "More than you can withdraw. " : ""}Available: <span className="font-mono tabular-nums">{fmtUsdc(max)}</span>
      </p>
      <div aria-live="polite">
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}

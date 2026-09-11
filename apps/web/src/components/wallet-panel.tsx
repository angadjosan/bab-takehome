"use client";

import Link from "next/link";
import { formatEther } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment, GAS_FAUCET_URL, NATIVE_SYMBOL, TEST_TOKEN } from "@/lib/config";
import { fmtDec, fmtUsdc } from "@/lib/format";
import { useClaimable } from "@/lib/market";
import { PRIVY_SPONSOR_GAS } from "@/lib/wallet-mode";
import { useTokenInfo, useWalletMode } from "./providers";
import { TxStatus, useTx } from "./tx";
import { cx } from "./ui";

/** Balances, claimable withdraw, faucet and account links for the connected account (both wallet modes). */
export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { address } = useAccount();
  const token = useTokenInfo();
  const { mode } = useWalletMode();
  const bal = useReadContract({
    address: deployment?.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!deployment, refetchInterval: 15_000 },
  });
  const eth = useBalance({ address, query: { enabled: !!address, refetchInterval: 15_000 } });
  const claimable = useClaimable(address);
  const withdraw = useTx();
  const faucet = useTx();
  const hasClaim = (claimable.data ?? 0n) > 0n;
  const ethLow = eth.data !== undefined && eth.data.value === 0n;
  return (
    <div className="space-y-2 text-sm">
      <div className="rounded bg-panel-2 p-3 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted">Balance</span>
          <span className="font-mono text-sm font-medium text-ink tabular-nums">{bal.data === undefined ? "…" : fmtUsdc(bal.data as bigint)}</span>
        </div>
        {claimable.data !== undefined && hasClaim && (
          <div className="mt-1.5 flex items-baseline justify-between gap-3">
            <span className="text-muted">Ready to withdraw</span>
            <span className="font-mono font-medium text-warn tabular-nums">{fmtUsdc(claimable.data)}</span>
          </div>
        )}
        {!(mode === "privy" && PRIVY_SPONSOR_GAS) && (
          <div className="mt-1.5 flex items-baseline justify-between gap-3">
            <span className="text-muted">Network fees ({NATIVE_SYMBOL})</span>
            <span className={cx("font-mono tabular-nums", ethLow ? "text-warn" : "text-muted")}>{eth.data === undefined ? "…" : fmtDec(Number(formatEther(eth.data.value)), 4)}</span>
          </div>
        )}
        {ethLow && !(mode === "privy" && PRIVY_SPONSOR_GAS) && GAS_FAUCET_URL && (
          <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" className="link mt-1 block text-[11px]">
            Get {NATIVE_SYMBOL} for fees
          </a>
        )}
        {hasClaim && deployment && (
          <button className="btn btn-primary btn-sm mt-3 w-full" disabled={withdraw.busy} onClick={() => withdraw.run("Withdraw", { address: deployment!.market, abi: marketAbi, functionName: "withdraw" })}>
            Withdraw {fmtUsdc(claimable.data)}
          </button>
        )}
        <TxStatus state={withdraw.state} />
        {token.hasFaucet && deployment && (
          <>
            <button className="btn btn-sm mt-2 w-full" disabled={faucet.busy} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
              Get test {token.symbol}
            </button>
            <TxStatus state={faucet.state} />
          </>
        )}
        {(TEST_TOKEN || token.hasFaucet) && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            <span translate="no">{token.symbol}</span> is a test token with no value.
          </p>
        )}
      </div>
      <nav aria-label="Account" className="flex flex-col">
        <Link href="/me/environments" className="rounded px-1.5 py-1.5 transition-colors duration-150 hover:bg-panel-2" onClick={onClose}>
          My environments
        </Link>
        <Link href="/me/purchases" className="rounded px-1.5 py-1.5 transition-colors duration-150 hover:bg-panel-2" onClick={onClose}>
          My purchases
        </Link>
        <Link href="/keys" className="rounded px-1.5 py-1.5 transition-colors duration-150 hover:bg-panel-2" onClick={onClose}>
          Delivery keys
        </Link>
      </nav>
    </div>
  );
}

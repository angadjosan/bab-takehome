"use client";

import Link from "next/link";
import { formatEther } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment, GAS_FAUCET_URL } from "@/lib/config";
import { fmtUsdc } from "@/lib/format";
import { useClaimable } from "@/lib/market";
import { tokenValueNote } from "@/lib/token";
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
      <div className="rounded-lg bg-panel-2 p-2.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted">Wallet balance</span>
          <span className="font-medium">{bal.data === undefined ? "…" : fmtUsdc(bal.data as bigint)}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Gas balance</span>
          <span className={cx("font-medium", ethLow && !PRIVY_SPONSOR_GAS && "text-warn")}>{eth.data === undefined ? "…" : `${Number(formatEther(eth.data.value)).toFixed(4)} ETH`}</span>
        </div>
        {ethLow && mode === "privy" && PRIVY_SPONSOR_GAS && <div className="mt-1 text-[11px] text-muted">No ETH needed: gas for your embedded wallet is sponsored.</div>}
        {ethLow && !(mode === "privy" && PRIVY_SPONSOR_GAS) && GAS_FAUCET_URL && (
          <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" className="link mt-1 block text-[11px]">
            Get Base Sepolia ETH for gas
          </a>
        )}
        {claimable.data !== undefined && (
          <div className="mt-1 flex items-center justify-between">
            <span className="text-muted" title="Refunds, returned bonds, seller proceeds and juror rewards are credited here and withdrawn by you (pull payments).">
              Claimable in market
            </span>
            <span className={cx("font-medium", hasClaim && "text-warn")}>{fmtUsdc(claimable.data)}</span>
          </div>
        )}
        {hasClaim && deployment && (
          <button className="btn btn-primary btn-sm mt-2 w-full" disabled={withdraw.busy} onClick={() => withdraw.run("Withdraw", { address: deployment!.market, abi: marketAbi, functionName: "withdraw" })}>
            Withdraw {fmtUsdc(claimable.data)}
          </button>
        )}
        <TxStatus state={withdraw.state} />
        {token.hasFaucet && deployment && (
          <>
            <button className="btn btn-sm mt-2 w-full" disabled={faucet.busy} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
              Get test {token.symbol} from the faucet
            </button>
            <TxStatus state={faucet.state} />
          </>
        )}
        <p className="mt-2 text-[11px] text-muted">{tokenValueNote()}</p>
      </div>
      <div className="flex flex-col">
        <Link href={`/seller/${address}`} className="rounded-md px-1 py-1.5 hover:bg-panel-2" onClick={onClose}>
          My purchases & seller dashboard
        </Link>
        <Link href="/jurors" className="rounded-md px-1 py-1.5 hover:bg-panel-2" onClick={onClose}>
          Juror stake
        </Link>
        <Link href="/keys" className="rounded-md px-1 py-1.5 hover:bg-panel-2" onClick={onClose}>
          My encryption keys
        </Link>
      </div>
    </div>
  );
}

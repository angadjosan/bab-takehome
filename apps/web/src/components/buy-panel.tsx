"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { useWalletEncKey } from "@/lib/enc-derive";
import { fmtUsdc, fmtWindow } from "@/lib/format";
import { useEncKeys } from "@/lib/keys";
import { isZeroHash, useSellerStake, type Version } from "@/lib/market";
import { useTokenInfo, useWalletMode } from "./providers";
import { friendlyError, RequireWallet, TxStatus, useTx } from "./tx";
import { useApproveAndCall } from "./tx-sequence";
import { Mono, Notice, Spinner } from "./ui";

export function BuyPanel({ v }: { v: Version }) {
  const { address } = useAccount();
  const stake = useSellerStake(v.seller);
  const blockers: string[] = [];
  if (!v.active) blockers.push("The seller has deactivated this version.");
  if (isZeroHash(v.reportHash)) blockers.push("No signed preview report is attached yet.");
  if (stake.data && stake.data.available < v.collateral)
    blockers.push(`The seller’s available collateral (${fmtUsdc(stake.data.available)}) is below the ${fmtUsdc(v.collateral)} each sale must reserve.`);
  if (address && address.toLowerCase() === v.seller.toLowerCase()) blockers.push("You are the seller of this version.");

  return (
    <div>
      <h3 className="text-sm font-semibold">Buy this environment</h3>
      {blockers.length ? (
        <div className="mt-3">
          <Notice tone="warn" title="Not purchasable right now">
            <ul className="list-disc pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : (
        <div className="mt-3">
          <RequireWallet why="Log in to buy.">
            <BuyAction v={v} />
          </RequireWallet>
        </div>
      )}
    </div>
  );
}

/**
 * One "Buy" button: (1) the wallet signs a fixed message once to derive the buyer's decryption key
 * (cached afterwards), (2) the exact price is approved if the allowance is short, (3) buy(). The
 * decryption key's public half goes on-chain; the relay wraps the bundle key to it.
 */
function BuyAction({ v }: { v: Version }) {
  const router = useRouter();
  const { address } = useAccount();
  const token = useTokenInfo();
  const { devTools } = useWalletMode();
  const { key: walletKey, derive } = useWalletEncKey();
  const { keys } = useEncKeys();
  const [override, setOverride] = useState("");
  const [termsAck, setTermsAck] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const faucet = useTx();
  const seq = useApproveAndCall();
  const market = deployment!.market;

  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { refetchInterval: 10_000 } });
  const balance = bal.data as bigint | undefined;
  const enoughFunds = balance !== undefined && balance >= v.price;
  const busy = seq.busy || phase !== null;

  async function doBuy() {
    setErr(null);
    let pub: Hex;
    try {
      if (devTools && override) pub = override as Hex;
      else {
        if (!walletKey) setPhase("Setting up your decryption key: approve the signature request in your wallet…");
        pub = (await derive()).publicKey;
      }
    } catch (e) {
      setErr(friendlyError(e));
      return;
    } finally {
      setPhase(null);
    }
    const receipt = await seq.run("Buy", v.price, { address: market, abi: marketAbi, functionName: "buy", args: [v.id, pub, v.price] });
    if (!receipt) return;
    const logs = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: "Purchased" as never });
    const pid = (logs[0] as { args?: { purchaseId?: bigint } } | undefined)?.args?.purchaseId;
    if (pid !== undefined) router.push(`/purchase/${pid}?new=1`);
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted">
        Balance {balance === undefined ? "…" : fmtUsdc(balance)}
        {!enoughFunds && balance !== undefined && ` · you need ${fmtUsdc(v.price)}`}
      </p>
      {!enoughFunds && balance !== undefined && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {token.hasFaucet ? (
            <button className="btn btn-sm" disabled={faucet.busy} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
              Get test {token.symbol}
            </button>
          ) : (
            <span className="text-warn">Add {token.symbol} to your wallet to continue.</span>
          )}
          <TxStatus state={faucet.state} />
        </div>
      )}

      <div className="rounded-lg border border-line p-3 text-xs text-muted">
        <ul className="list-disc space-y-1 pl-4">
          <li>Your {fmtUsdc(v.price)} is held by the contract, not the seller.</li>
          <li>If the environment isn’t delivered within {fmtWindow(v.deliveryWindow)}, you get a full refund.</li>
          <li>After delivery you have {fmtWindow(v.challengeWindow)} to dispute specific tasks. Poor training results alone don’t qualify.</li>
        </ul>
        <label className="mt-2 flex items-start gap-2 text-ink">
          <input type="checkbox" className="mt-0.5" checked={termsAck} onChange={(e) => setTermsAck(e.target.checked)} />
          <span>I understand the preview is not a guarantee of training value and refunds after delivery are capped.</span>
        </label>
      </div>

      <button className="btn btn-primary w-full" disabled={!enoughFunds || !termsAck || busy} onClick={doBuy}>
        {busy ? <Spinner className="h-3.5 w-3.5" /> : null} Buy for {fmtUsdc(v.price)}
      </button>
      {phase && <p className="text-xs text-muted">{phase}</p>}
      <TxStatus state={seq.state} />
      {err && <p className="break-words text-xs text-bad">{err}</p>}

      {devTools && (
        <details className="rounded-lg border border-dashed border-line px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">Dev tools: encryption key</summary>
          <p className="mt-2 text-muted">Default: derived from this wallet{walletKey ? "" : " on first purchase"}.</p>
          {walletKey && <Mono className="block break-all">{walletKey.publicKey}</Mono>}
          {keys.length > 0 && (
            <select className="input mt-2 font-mono text-xs" value={override} onChange={(e) => setOverride(e.target.value)}>
              <option value="">use the wallet-derived key</option>
              {keys.map((k) => (
                <option key={k.publicKey} value={k.publicKey}>
                  {k.publicKey.slice(0, 18)}… {k.label ?? ""}
                </option>
              ))}
            </select>
          )}
        </details>
      )}
    </div>
  );
}

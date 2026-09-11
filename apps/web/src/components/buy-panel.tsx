"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { useWalletEncKey } from "@/lib/enc-derive";
import { fmtUsdc } from "@/lib/format";
import { useEncKeys } from "@/lib/keys";
import { isZeroHash, useMarketParams, useSellerStake, type Version } from "@/lib/market";
import { useTokenInfo, useWalletMode } from "./providers";
import { friendlyError, RequireWallet, TxStatus, useTx } from "./tx";
import { useApproveAndCall } from "./tx-sequence";
import { Mono, Notice, Spinner } from "./ui";

/** Lives inside the listing page's price box, which already shows the price and refund terms. */
export function BuyPanel({ v }: { v: Version }) {
  const { address } = useAccount();
  const { mode } = useWalletMode();
  const stake = useSellerStake(v.seller);
  const params = useMarketParams();
  const blockers: string[] = [];
  if (!v.active) blockers.push("The seller has paused sales of this version.");
  if (isZeroHash(v.reportHash)) blockers.push("No signed preview report is attached yet.");
  // buy() requires collateral ≥ caseFee + price·penaltyBps/10000 (CollateralBelowRequirement)
  const required = params.data ? params.data.caseFee + (v.price * BigInt(params.data.penaltyBps)) / 10000n : undefined;
  if (required !== undefined && v.collateral < required) blockers.push(`This version’s collateral (${fmtUsdc(v.collateral)}) is below the ${fmtUsdc(required)} the market requires per sale.`);
  if (stake.data && stake.data.available < v.collateral)
    blockers.push(`The seller’s available stake (${fmtUsdc(stake.data.available)}) is below the ${fmtUsdc(v.collateral)} collateral each sale reserves.`);
  if (address && address.toLowerCase() === v.seller.toLowerCase()) blockers.push("This is your own listing.");

  if (blockers.length)
    return (
      <Notice tone="neutral" title="Not for sale right now">
        {blockers.length === 1 ? (
          blockers[0]
        ) : (
          <ul className="list-disc space-y-1 pl-4">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </Notice>
    );

  return (
    <RequireWallet why={mode === "privy" ? "Sign in to buy." : "Connect a wallet to buy."}>
      <BuyAction v={v} />
    </RequireWallet>
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
        if (!walletKey) setPhase("Setting up your download key. Approve the signature request in your wallet…");
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

  const buttonText = phase
    ? "Waiting for your signature…"
    : seq.step === "1/2"
      ? `Allowing the payment… (${seq.step})`
      : seq.step === "2/2"
        ? `Paying… (${seq.step})`
        : seq.busy
          ? "Paying…"
          : `Buy for ${fmtUsdc(v.price)}`;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="text-muted">Your balance</span>
        <span className={enoughFunds || balance === undefined ? "font-mono text-ink tabular-nums" : "font-mono text-warn tabular-nums"}>{balance === undefined ? "…" : fmtUsdc(balance)}</span>
      </div>
      {!enoughFunds && balance !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs" aria-live="polite">
          <span className="text-muted">
            You need <span className="font-mono tabular-nums">{fmtUsdc(v.price - balance)}</span> more.
          </span>
          {token.hasFaucet ? (
            <button className="btn btn-sm" disabled={faucet.busy} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
              {faucet.busy ? "Sending test tokens…" : `Get test ${token.symbol}`}
            </button>
          ) : (
            <span className="text-warn">Add {token.symbol} to your wallet to continue.</span>
          )}
          <div className="w-full">
            <TxStatus state={faucet.state} />
          </div>
        </div>
      )}

      <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-muted">
        <input type="checkbox" name="terms" className="mt-1 shrink-0 accent-[var(--accent-fill)]" checked={termsAck} onChange={(e) => setTermsAck(e.target.checked)} />
        <span>I accept the terms above.</span>
      </label>

      <button className="btn btn-primary h-10 w-full" disabled={!enoughFunds || !termsAck || busy} onClick={doBuy}>
        {busy && <Spinner className="h-3.5 w-3.5" />}
        {buttonText}
      </button>

      <div aria-live="polite" className="space-y-1 text-xs">
        {phase && <p className="text-muted">{phase}</p>}
        <TxStatus state={seq.state} />
        {err && (
          <p role="alert" className="text-bad [overflow-wrap:anywhere]">
            {err}
          </p>
        )}
      </div>

      {devTools && (
        <details className="rounded-md border border-dashed border-line px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">Dev tools: encryption key</summary>
          <p className="mt-2 text-muted">Default: derived from this wallet{walletKey ? "" : " on first purchase"}.</p>
          {walletKey && <Mono className="block [overflow-wrap:anywhere]">{walletKey.publicKey}</Mono>}
          {keys.length > 0 && (
            <select aria-label="Encryption key for this purchase" name="encKey" className="input mt-2 font-mono text-xs" value={override} onChange={(e) => setOverride(e.target.value)}>
              <option value="">Use the wallet-derived key</option>
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

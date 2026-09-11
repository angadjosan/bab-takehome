"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEventLogs } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { encKeyFromSecret, generateEncKey, type EncKey } from "@/lib/crypto";
import { fmtUsdc, fmtWindow } from "@/lib/format";
import { downloadKey, useEncKeys } from "@/lib/keys";
import { isZeroHash, useSellerStake, type Version } from "@/lib/market";
import { tokenValueNote } from "@/lib/token";
import { useTokenInfo } from "./providers";
import { RequireWallet, TxStatus, useTx } from "./tx";
import { cx, IconCheck, Mono, Notice } from "./ui";

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
          <RequireWallet why="Connect a wallet to buy. You will sign two transactions: an exact-amount token approval and the purchase.">
            <BuySteps v={v} />
          </RequireWallet>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: React.ReactNode }) {
  return (
    <li className="relative pl-8">
      <span
        className={cx(
          "absolute left-0 top-0 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
          done ? "bg-ok text-white" : "bg-accent-soft text-accent",
        )}
      >
        {done ? <IconCheck className="h-3 w-3" /> : n}
      </span>
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mt-2 space-y-2 text-xs">{children}</div>}
    </li>
  );
}

function BuySteps({ v }: { v: Version }) {
  const router = useRouter();
  const { address } = useAccount();
  const token = useTokenInfo();
  const { keys, add } = useEncKeys();
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const [savedAck, setSavedAck] = useState<Record<string, boolean>>({});
  const [termsAck, setTermsAck] = useState(false);
  const faucet = useTx();
  const approve = useTx();
  const buy = useTx();

  const key: EncKey | undefined = keys.find((k) => k.publicKey === selected) ?? keys[0];
  const market = deployment!.market;

  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { refetchInterval: 10_000 } });
  const allowance = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "allowance", args: [address!, market], query: { refetchInterval: 10_000 } });
  const balance = bal.data as bigint | undefined;
  const allowed = allowance.data as bigint | undefined;
  const enoughFunds = balance !== undefined && balance >= v.price;
  const approved = allowed !== undefined && allowed >= v.price;
  const keySaved = !!key && (savedAck[key.publicKey] || key.label === "imported");

  function newKey() {
    const k = generateEncKey();
    add(k);
    setSelected(k.publicKey);
    downloadKey(k);
    setSavedAck((s) => ({ ...s, [k.publicKey]: false }));
  }

  function doImport() {
    try {
      const k = encKeyFromSecret(importText);
      add(k);
      setSelected(k.publicKey);
      setImporting(false);
      setImportText("");
      setImportErr(null);
    } catch (e) {
      setImportErr((e as Error).message);
    }
  }

  async function doBuy() {
    if (!key) return;
    const receipt = await buy.run("Buy", { address: market, abi: marketAbi, functionName: "buy", args: [v.id, key.publicKey, v.price] });
    if (!receipt) return;
    const logs = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: "Purchased" as never });
    const pid = (logs[0] as { args?: { purchaseId?: bigint } } | undefined)?.args?.purchaseId;
    if (pid !== undefined) router.push(`/purchase/${pid}?new=1`);
  }

  return (
    <ol className="space-y-5">
      <Step n={1} title="Choose an encryption key" done={!!key && keySaved}>
        <p className="text-muted">
          The relay encrypts the bundle key to this X25519 public key. It is not your wallet key. The secret half stays in this browser (localStorage); if you lose it you
          cannot decrypt what you bought.
        </p>
        {keys.length > 0 && (
          <select className="input font-mono text-xs" value={key?.publicKey ?? ""} onChange={(e) => setSelected(e.target.value)}>
            {keys.map((k) => (
              <option key={k.publicKey} value={k.publicKey}>
                {k.publicKey.slice(0, 18)}… {k.label ? `(${k.label})` : ""} · {new Date(k.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={newKey}>
            Generate new key
          </button>
          <button className="btn btn-sm" onClick={() => setImporting((x) => !x)}>
            Import secret key
          </button>
          {key && (
            <button className="btn btn-sm" onClick={() => downloadKey(key)}>
              Download backup
            </button>
          )}
        </div>
        {importing && (
          <div className="space-y-1.5">
            <input className="input font-mono text-xs" placeholder="0x… 32-byte X25519 secret key" value={importText} onChange={(e) => setImportText(e.target.value)} />
            <button className="btn btn-sm" onClick={doImport} disabled={!importText}>
              Import
            </button>
            {importErr && <p className="text-bad">{importErr}</p>}
          </div>
        )}
        {key && (
          <>
            <div className="rounded-md bg-panel-2 px-2 py-1.5">
              public key <Mono className="break-all">{key.publicKey}</Mono>
            </div>
            {key.label !== "imported" && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={!!savedAck[key.publicKey]} onChange={(e) => setSavedAck((s) => ({ ...s, [key.publicKey]: e.target.checked }))} />
                <span>I saved the downloaded key file somewhere safe. Clearing browser data deletes the in-browser copy.</span>
              </label>
            )}
          </>
        )}
      </Step>

      <Step n={2} title={`Have ${fmtUsdc(v.price)} in your wallet`} done={enoughFunds}>
        <p className="text-muted">
          Balance: <span className="font-medium text-ink">{balance === undefined ? "…" : fmtUsdc(balance)}</span>. {tokenValueNote()} Gas is paid separately in ETH.
        </p>
        {!enoughFunds && token.hasFaucet && (
          <button className="btn btn-sm" disabled={faucet.busy} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
            Get test {token.symbol} from the faucet
          </button>
        )}
        {!enoughFunds && !token.hasFaucet && balance !== undefined && <p className="text-warn">Top up your wallet with {token.symbol} on this network to continue.</p>}
        <TxStatus state={faucet.state} />
      </Step>

      <Step n={3} title="Approve the exact price" done={approved}>
        <p className="text-muted">Allows the market contract to pull exactly {fmtUsdc(v.price)}, and no more.</p>
        {!approved && (
          <button
            className="btn btn-sm"
            disabled={!enoughFunds || approve.busy}
            onClick={() => approve.run("Approve", { address: deployment!.token, abi: tokenAbi, functionName: "approve", args: [market, v.price] })}
          >
            Approve {fmtUsdc(v.price)}
          </button>
        )}
        <TxStatus state={approve.state} />
      </Step>

      <Step n={4} title="Pay into escrow">
        <div className="rounded-lg border border-line p-3 text-muted">
          <ul className="list-disc space-y-1 pl-4">
            <li>Your {fmtUsdc(v.price)} is held by the contract, not the seller.</li>
            <li>If the key is not delivered within {fmtWindow(v.deliveryWindow)}, anyone can trigger a full refund.</li>
            <li>After delivery you have {fmtWindow(v.challengeWindow)} to dispute specific tasks under one of three grounds. Poor training results alone do not qualify; reward hacking is out of scope.</li>
            <li>Refunds and returned bonds are credited to you inside the market and withdrawn with one click.</li>
          </ul>
          <label className="mt-2 flex items-start gap-2 text-ink">
            <input type="checkbox" className="mt-0.5" checked={termsAck} onChange={(e) => setTermsAck(e.target.checked)} />
            <span>I understand the preview is not a guarantee of training value and post-delivery refunds are capped.</span>
          </label>
        </div>
        <button className="btn btn-primary w-full" disabled={!key || !keySaved || !approved || !enoughFunds || !termsAck || buy.busy} onClick={doBuy}>
          Buy for {fmtUsdc(v.price)}
        </button>
        {!keySaved && key && <p className="text-muted">Confirm you saved your encryption key first.</p>}
        <TxStatus state={buy.state} />
      </Step>
    </ol>
  );
}

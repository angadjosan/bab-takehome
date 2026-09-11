"use client";

import { useExportWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useEffect, useRef, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { fmtUsdc, shortAddr } from "@/lib/format";
import { useClaimable } from "@/lib/market";
import { PRIVY_SPONSOR_GAS } from "@/lib/wallet-mode";
import { AccountPanel } from "./wallet-panel";
import { Chip, cx } from "./ui";

/** Header account control in Privy mode: sign in, balance, wallets, export, sign out. */
export function PrivyWalletButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const { setActiveWallet } = useSetActiveWallet();
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { data: bal } = useReadContract({
    address: deployment?.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!deployment, refetchInterval: 15_000 },
  });
  const claimable = useClaimable(address);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  if (!ready)
    return (
      <button className="btn btn-sm" disabled>
        Loading…
      </button>
    );
  if (!authenticated)
    return (
      <button className="btn btn-sm" onClick={() => login()}>
        Sign in
      </button>
    );

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const active = address ?? embedded?.address;
  const who = user?.email?.address ?? user?.google?.email ?? (user?.wallet?.address ? shortAddr(user.wallet.address) : "your account");
  const hasClaim = (claimable.data ?? 0n) > 0n;

  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-sm" aria-haspopup="dialog" aria-expanded={open} aria-label={`Account menu${hasClaim ? ", you have funds to withdraw" : ""}`} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", hasClaim ? "bg-warn" : "bg-ok")} />
        <span className="font-mono tabular-nums">{bal !== undefined ? fmtUsdc(bal as bigint) : active ? shortAddr(active) : "Account"}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] space-y-3 overscroll-contain rounded-md bg-panel p-3 [box-shadow:var(--overlay-shadow)]">
          <div className="text-xs text-muted">
            Signed in as <span className="text-ink [overflow-wrap:anywhere]">{who}</span>
          </div>
          <AccountPanel onClose={() => setOpen(false)} />
          <details className="group rounded border border-line text-xs">
            <summary className="cursor-pointer list-none px-2.5 py-2 text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
              Wallet details <span className="text-faint">({wallets.length})</span>
            </summary>
            <div className="space-y-1.5 border-t border-line p-2">
              {wallets.map((w) => {
                const isActive = !!address && w.address.toLowerCase() === address.toLowerCase();
                return (
                  <div key={w.address} className={cx("rounded border px-2 py-1.5", isActive ? "border-accent/40 bg-accent-soft" : "border-line")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{w.walletClientType === "privy" ? "Wallet created at sign-in" : `Your ${w.walletClientType} wallet`}</span>
                      {isActive ? (
                        <Chip tone="accent">In use</Chip>
                      ) : (
                        <button className="cursor-pointer text-accent hover:underline" onClick={() => setActiveWallet(w).catch((e) => setErr((e as Error).message))}>
                          Use this one
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-muted [overflow-wrap:anywhere]" translate="no">
                      {w.address}
                    </div>
                    {w.walletClientType === "privy" && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-muted">
                        <span>{PRIVY_SPONSOR_GAS ? "Network fees covered" : "Pays its own network fees"}</span>
                        <button className="cursor-pointer text-accent hover:underline" onClick={() => exportWallet({ address: w.address }).catch((e) => setErr((e as Error).message))}>
                          Export private key
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
          {err && (
            <p role="alert" className="text-xs text-bad">
              {err}
            </p>
          )}
          <div className="border-t border-line pt-1">
            <button
              className="w-full cursor-pointer rounded px-1 py-1.5 text-left text-sm text-bad transition-colors duration-150 hover:bg-panel-2"
              onClick={async () => {
                setOpen(false);
                await logout();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

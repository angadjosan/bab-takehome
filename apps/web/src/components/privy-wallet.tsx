"use client";

import { useExportWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { shortAddr } from "@/lib/format";
import { PRIVY_SPONSOR_GAS } from "@/lib/wallet-mode";
import { AccountPanel } from "./wallet-panel";
import { cx } from "./ui";

/** Header wallet control in Privy mode: login, embedded/external wallet, balances, export, logout. */
export function PrivyWalletButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const { setActiveWallet } = useSetActiveWallet();
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  if (!ready) return <button className="btn btn-sm opacity-60" disabled>Loading…</button>;
  if (!authenticated)
    return (
      <button className="btn btn-primary btn-sm" onClick={() => login()}>
        Log in
      </button>
    );

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const active = address ?? embedded?.address;
  const who = user?.email?.address ?? user?.google?.email ?? (user?.wallet?.address ? shortAddr(user.wallet.address) : "your account");

  return (
    <div className="relative" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
        <span className="h-2 w-2 rounded-full bg-ok" />
        <span className="font-mono text-xs">{active ? shortAddr(active) : "wallet…"}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 space-y-2 rounded-xl border border-line bg-panel p-3 shadow-lg">
          <div className="text-xs text-muted">Logged in as {who}</div>
          <div className="space-y-1">
            {wallets.map((w) => {
              const isActive = !!address && w.address.toLowerCase() === address.toLowerCase();
              return (
                <div key={w.address} className={cx("rounded-lg border px-2 py-1.5 text-xs", isActive ? "border-accent bg-accent-soft" : "border-line")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{w.walletClientType === "privy" ? "Embedded wallet" : `External · ${w.walletClientType}`}</span>
                    {isActive ? (
                      <span className="badge badge-accent">active</span>
                    ) : (
                      <button className="text-accent hover:underline" onClick={() => setActiveWallet(w).catch((e) => setErr((e as Error).message))}>
                        use
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 break-all font-mono">{w.address}</div>
                  {w.walletClientType === "privy" && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-muted">
                      <span>{PRIVY_SPONSOR_GAS ? "gas sponsored" : "pays its own gas"}</span>
                      <button className="text-accent hover:underline" onClick={() => exportWallet({ address: w.address }).catch((e) => setErr((e as Error).message))}>
                        Export wallet (private key)
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {err && <p className="text-xs text-bad">{err}</p>}
          <AccountPanel onClose={() => setOpen(false)} />
          <button
            className="w-full rounded-md px-1 py-1.5 text-left text-sm text-bad hover:bg-panel-2"
            onClick={async () => {
              setOpen(false);
              await logout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

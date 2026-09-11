"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { CHAIN_ID, CHAIN_NAME, deployment, TEE_URL, addressUrl, IS_MAINNET } from "@/lib/config";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { fmtUsdc, shortAddr } from "@/lib/format";
import { useClaimable } from "@/lib/market";
import { tokenValueNote } from "@/lib/token";
import { useTokenInfo } from "./providers";
import { useTx, TxStatus } from "./tx";
import { cx, IconExternal } from "./ui";

const NAV = [
  { href: "/", label: "Marketplace" },
  { href: "/activity", label: "Activity" },
  { href: "/keys", label: "My keys" },
  { href: "/how-it-works", label: "How it works" },
];

export function SiteHeader() {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" || path.startsWith("/listing") : path.startsWith(href));
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          <span className="hidden sm:inline">RL Environment Market</span>
          <span className="sm:hidden">EnvMarket</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx("rounded-md px-2.5 py-1.5 text-sm", isActive(n.href) ? "bg-panel-2 font-medium text-ink" : "text-muted hover:text-ink")}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-muted sm:inline-flex" title={deployment ? "Contracts deployed" : "No deployment for this chain"}>
            <span className={cx("h-1.5 w-1.5 rounded-full", deployment ? "bg-ok" : "bg-warn")} />
            {CHAIN_NAME}
            {IS_MAINNET && <span className="text-[10px] font-semibold uppercase text-warn">mainnet</span>}
          </span>
          <WalletButton />
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-line px-4 py-1.5 md:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={cx("whitespace-nowrap rounded-md px-2.5 py-1 text-sm", isActive(n.href) ? "bg-panel-2 text-ink" : "text-muted")}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--accent)" />
      <path d="M7 8.5h10M7 12h6M7 15.5h8" stroke="var(--accent-ink)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function WalletButton() {
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const token = useTokenInfo();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: bal } = useReadContract({
    address: deployment?.token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!deployment, refetchInterval: 15_000 },
  });
  const claimable = useClaimable(address);
  const withdraw = useTx();
  const faucet = useTx();

  // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration guard: wallet state only exists client-side
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  if (!mounted) return <button className="btn btn-sm opacity-0" aria-hidden>Connect wallet</button>;

  const wrongChain = isConnected && chainId !== CHAIN_ID;
  const uniq = connectors.filter((c, i, arr) => arr.findIndex((x) => x.name === c.name) === i);
  const hasClaim = (claimable.data ?? 0n) > 0n;

  return (
    <div className="relative" ref={ref}>
      {!isConnected ? (
        <button className="btn btn-primary btn-sm" onClick={() => setOpen((o) => !o)} disabled={isPending}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
      ) : wrongChain ? (
        <button className="btn btn-sm border-warn text-warn" onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={switching}>
          {switching ? "Switching…" : `Switch to ${CHAIN_NAME}`}
        </button>
      ) : (
        <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
          <span className={cx("h-2 w-2 rounded-full", hasClaim ? "bg-warn" : "bg-ok")} />
          <span className="font-mono text-xs">{shortAddr(address)}</span>
          {bal !== undefined && <span className="hidden text-xs text-muted sm:inline">{fmtUsdc(bal as bigint)}</span>}
        </button>
      )}
      {open && (
        <div className="absolute right-0 mt-2 w-80 rounded-xl border border-line bg-panel p-2 shadow-lg">
          {!isConnected ? (
            <>
              <div className="px-2 pb-2 pt-1 text-xs text-muted">
                Connect a wallet on {CHAIN_NAME}. Browsing is read-only; a wallet is only needed to buy, dispute, finalize, rate, or withdraw.
              </div>
              {uniq.map((c) => (
                <button
                  key={c.uid}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-panel-2"
                  onClick={() => {
                    connect({ connector: c, chainId: CHAIN_ID });
                    setOpen(false);
                  }}
                >
                  {c.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.icon} alt="" className="h-5 w-5 rounded" />
                  ) : (
                    <span className="h-5 w-5 rounded bg-panel-2" />
                  )}
                  {c.name === "Injected" ? "Browser wallet (MetaMask, Rabby…)" : c.name}
                </button>
              ))}
              {error && <p className="px-2 pt-1 text-xs text-bad">{error.message.split("\n")[0]}</p>}
            </>
          ) : (
            <div className="space-y-2 p-1 text-sm">
              <div>
                <div className="text-xs text-muted">Connected with {connector?.name}</div>
                <div className="break-all font-mono text-xs">{address}</div>
              </div>
              <div className="rounded-lg bg-panel-2 p-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted">Wallet balance</span>
                  <span className="font-medium">{bal === undefined ? "…" : fmtUsdc(bal as bigint)}</span>
                </div>
                {claimable.data !== undefined && (
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-muted" title="Refunds, returned bonds, seller proceeds and juror rewards are credited here and withdrawn by you (pull payments).">
                      Claimable in market
                    </span>
                    <span className={cx("font-medium", hasClaim && "text-warn")}>{fmtUsdc(claimable.data)}</span>
                  </div>
                )}
                {hasClaim && deployment && (
                  <button
                    className="btn btn-primary btn-sm mt-2 w-full"
                    disabled={withdraw.busy}
                    onClick={() => withdraw.run("Withdraw", { address: deployment!.market, abi: marketAbi, functionName: "withdraw" })}
                  >
                    Withdraw {fmtUsdc(claimable.data)}
                  </button>
                )}
                <TxStatus state={withdraw.state} />
                {token.hasFaucet && deployment && (
                  <>
                    <button
                      className="btn btn-sm mt-2 w-full"
                      disabled={faucet.busy}
                      onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}
                    >
                      Get test {token.symbol} from faucet
                    </button>
                    <TxStatus state={faucet.state} />
                  </>
                )}
                <p className="mt-2 text-[11px] text-muted">{tokenValueNote()}</p>
              </div>
              <div className="flex flex-col">
                <Link href={`/seller/${address}`} className="rounded-md px-1 py-1.5 hover:bg-panel-2" onClick={() => setOpen(false)}>
                  My purchases & seller profile
                </Link>
                <Link href="/keys" className="rounded-md px-1 py-1.5 hover:bg-panel-2" onClick={() => setOpen(false)}>
                  My encryption keys
                </Link>
                <button
                  className="rounded-md px-1 py-1.5 text-left text-bad hover:bg-panel-2"
                  onClick={() => {
                    disconnect();
                    setOpen(false);
                  }}
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SiteFooter() {
  useTokenInfo();
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-xs text-muted sm:grid-cols-3 sm:px-6">
        <div className="space-y-1.5">
          <div className="font-semibold text-ink">RL Environment Market</div>
          <p>
            Running on {CHAIN_NAME} (chain {CHAIN_ID}). {tokenValueNote()}
          </p>
          <p>
            <Link href="/how-it-works" className="link">
              Trust assumptions & what is real
            </Link>
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="font-semibold text-ink">Contracts</div>
          {deployment ? (
            <>
              <FooterAddr label="EnvMarket" addr={deployment.market} />
              <FooterAddr label="Payment token" addr={deployment.token} />
              <div>Events indexed from block {deployment.startBlock.toString()}</div>
            </>
          ) : (
            <div>Not deployed on this chain yet.</div>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="font-semibold text-ink">TEE service</div>
          {TEE_URL ? (
            <a href={`${TEE_URL}/health`} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 break-all">
              {TEE_URL} <IconExternal />
            </a>
          ) : (
            <div>NEXT_PUBLIC_TEE_URL not configured.</div>
          )}
          <p>Every value on this site is read live from the chain or the TEE service and checked in your browser; nothing is simulated.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterAddr({ label, addr }: { label: string; addr: string }) {
  const u = addressUrl(addr);
  return (
    <div className="flex items-center gap-1">
      <span>{label}:</span>
      {u ? (
        <a className="link inline-flex items-center gap-1 font-mono" href={u} target="_blank" rel="noreferrer">
          {shortAddr(addr)} <IconExternal />
        </a>
      ) : (
        <span className="font-mono">{shortAddr(addr)}</span>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { CHAIN_ID, CHAIN_NAME, deployment, TEE_URL, addressUrl, IS_MAINNET, GAS_FAUCET_URL } from "@/lib/config";
import { tokenAbi } from "@/lib/abi";
import { BURNER_CONNECTOR_ID } from "@/lib/burner";
import { fmtUsdc, shortAddr } from "@/lib/format";
import { useClaimable } from "@/lib/market";
import { tokenValueNote } from "@/lib/token";
import { PRIVY_SPONSOR_GAS } from "@/lib/wallet-mode";
import { BurnerForm, BurnerSwitcher } from "./burner-ui";
import { PrivyWalletButton } from "./privy-wallet";
import { useTokenInfo, useWalletMode } from "./providers";
import { useTx, TxStatus } from "./tx";
import { cx, IconExternal } from "./ui";
import { AccountPanel } from "./wallet-panel";

const NAV = [
  { href: "/", label: "Marketplace" },
  { href: "/activity", label: "Activity" },
  { href: "/jurors", label: "Jurors" },
  { href: "/keys", label: "My keys" },
  { href: "/how-it-works", label: "How it works" },
];

export function SiteHeader() {
  const path = usePathname();
  const { mode, devTools, privyConfigured } = useWalletMode();
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
            {devTools && <span className="text-[10px] font-semibold uppercase text-accent">dev tools</span>}
          </span>
          {mode === "privy" ? <PrivyWalletButton /> : <WagmiWalletButton />}
        </div>
      </div>
      {!privyConfigured && !devTools && (
        <div className="border-t border-line bg-info-soft">
          <div className="mx-auto max-w-6xl px-4 py-1.5 text-xs text-info sm:px-6">
            Wallet login (Privy) is not configured for this deployment: set <code className="font-mono">NEXT_PUBLIC_PRIVY_APP_ID</code> (see apps/web/README.md). Browser wallets still work.
          </div>
        </div>
      )}
      {!IS_MAINNET && <TestnetBanner />}
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

/**
 * Always-visible testnet strip: what the token is worth (nothing), the TestUSDC faucet for the
 * connected wallet (rate-limited on-chain; shows when it can be used again), and where to get
 * Base Sepolia ETH for gas (unless gas is sponsored).
 */
function TestnetBanner() {
  const { address, isConnected } = useAccount();
  const { mode } = useWalletMode();
  const token = useTokenInfo();
  const faucet = useTx();
  const { data: availableAt } = useReadContract({
    address: deployment?.token,
    abi: tokenAbi,
    functionName: "faucetAvailableAt",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!deployment && token.hasFaucet, refetchInterval: 15_000 },
  });
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const waitUntil = availableAt !== undefined ? Number(availableAt as bigint) : 0;
  const coolingDown = waitUntil > now;
  const sponsored = mode === "privy" && PRIVY_SPONSOR_GAS;
  return (
    <div className="border-t border-line bg-warn-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 text-xs sm:px-6">
        <span className="font-semibold text-warn">
          {CHAIN_NAME} testnet · {token.symbol} has no value
        </span>
        {deployment &&
          token.hasFaucet &&
          (isConnected ? (
            <span className="flex items-center gap-2">
              <button className="btn btn-primary btn-sm" disabled={faucet.busy || coolingDown} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
                Get test {token.symbol}
              </button>
              {coolingDown && <span className="text-muted">faucet used; available again {new Date(waitUntil * 1000).toLocaleString()}</span>}
              <TxStatus state={faucet.state} />
            </span>
          ) : (
            <span className="text-muted">{mode === "privy" ? "Log in (top right) to get" : "Connect a wallet to get"} test {token.symbol} from the faucet.</span>
          ))}
        {sponsored ? (
          <span className="text-muted">Gas is sponsored for wallets created at login.</span>
        ) : (
          GAS_FAUCET_URL && (
            <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
              Base Sepolia ETH for gas <IconExternal />
            </a>
          )
        )}
      </div>
    </div>
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

/** wagmi mode: browser wallets; with dev tools also burner keys and a per-session account switcher. */
function WagmiWalletButton() {
  const { address, isConnected, connector } = useAccount();
  const { devTools } = useWalletMode();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
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

  // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration guard: wallet state only exists client-side
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  if (!mounted) return <button className="btn btn-sm opacity-0" aria-hidden>Connect wallet</button>;

  const wrongChain = isConnected && chainId !== CHAIN_ID;
  const uniq = connectors.filter((c, i, arr) => c.id !== BURNER_CONNECTOR_ID && arr.findIndex((x) => x.name === c.name) === i);
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
              {devTools && (
                <div className="mt-2 space-y-2 border-t border-line px-2 pb-1 pt-2">
                  <div className="text-xs font-medium">Use a burner key (dev tool)</div>
                  <BurnerSwitcher onSwitch={() => setOpen(false)} />
                  <BurnerForm onDone={() => setOpen(false)} />
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2 p-1 text-sm">
              <div>
                <div className="text-xs text-muted">Connected with {connector?.name}</div>
                <div className="break-all font-mono text-xs">{address}</div>
              </div>
              {devTools && (
                <>
                  <BurnerSwitcher />
                  <details className="rounded-lg border border-line px-2 py-1.5 text-xs">
                    <summary className="cursor-pointer text-muted">Add a burner key (switch perspective)</summary>
                    <div className="mt-2">
                      <BurnerForm />
                    </div>
                  </details>
                </>
              )}
              <AccountPanel onClose={() => setOpen(false)} />
              <button
                className="w-full rounded-md px-1 py-1.5 text-left text-bad hover:bg-panel-2"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
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

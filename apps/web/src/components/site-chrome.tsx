"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { CHAIN_ID, CHAIN_NAME, deployment, GAS_FAUCET_URL, NATIVE_SYMBOL, TEE_TRUST_URL, TEST_TOKEN } from "@/lib/config";
import { tokenAbi } from "@/lib/abi";
import { BURNER_CONNECTOR_ID } from "@/lib/burner";
import { fmtTime, fmtUsdc, shortAddr } from "@/lib/format";
import { useClaimable } from "@/lib/market";
import { PRIVY_SPONSOR_GAS } from "@/lib/wallet-mode";
import { BurnerForm, BurnerSwitcher } from "./burner-ui";
import { PrivyWalletButton } from "./privy-wallet";
import { useTokenInfo, useWalletMode } from "./providers";
import { FaucetStatus, useFaucet } from "./faucet";
import { AddressLink, cx, IconExternal } from "./ui";
import { AccountPanel } from "./wallet-panel";

const NAV = [
  { href: "/", label: "Browse" },
  { href: "/activity", label: "Activity" },
  { href: "/jurors", label: "Jurors" },
];

export function SiteHeader() {
  const path = usePathname();
  const { mode, devTools } = useWalletMode();
  const token = useTokenInfo();
  const isActive = (href: string) => (href === "/" ? path === "/" || path.startsWith("/listing") : path.startsWith(href));
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight text-ink" aria-label="RL Environment Market, home">
          <Logo />
          <span className="hidden sm:inline">RL Environment Market</span>
          <span className="sm:hidden">EnvMarket</span>
        </Link>
        <nav aria-label="Primary" className="hidden h-full items-stretch gap-1 md:flex">
          {NAV.map((n) => (
            <NavLink key={n.href} href={n.href} active={isActive(n.href)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {devTools && (
            <span className="hidden h-7 items-center rounded-md border border-line px-2 font-mono text-[11px] text-accent uppercase sm:inline-flex" title={`Burner keys enabled · chain ${CHAIN_ID}`}>
              Dev tools
            </span>
          )}
          {mode === "privy" ? <PrivyWalletButton /> : <WagmiWalletButton />}
        </div>
      </div>
      <nav
        aria-label="Primary"
        className="flex gap-1 overflow-x-auto border-t border-line pr-8 pl-2 [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] md:hidden [scrollbar-width:none]"
      >
        {NAV.map((n) => (
          <NavLink key={n.href} href={n.href} active={isActive(n.href)} compact>
            {n.label}
          </NavLink>
        ))}
      </nav>
      {(TEST_TOKEN || token.hasFaucet) && <TestnetBanner />}
    </header>
  );
}

function NavLink({ href, active, compact, children }: { href: string; active: boolean; compact?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex items-center px-2.5 text-[13px] whitespace-nowrap transition-colors duration-150",
        compact && "h-10",
        active ? "font-medium text-ink after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:bg-accent" : "text-muted hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * Test-token strip, shown when the deployment file marks the token as a test token or the token
 * exposes a public faucet: the "no value" note (deployment file flag only), the faucet for the
 * connected wallet (rate-limited on-chain; shows when it can be used again), and a gas faucet link
 * when one is configured and gas isn't sponsored.
 */
function TestnetBanner() {
  const { address, isConnected } = useAccount();
  const { mode } = useWalletMode();
  const token = useTokenInfo();
  const faucet = useFaucet();
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
    <div className="border-t border-line bg-panel">
      <div className="mx-auto flex min-h-9 max-w-6xl flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-1.5 text-xs sm:px-6">
        {TEST_TOKEN && (
          <span className="inline-flex items-center gap-2 text-muted">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warn" />
            <span>
              <span className="font-medium text-ink">Test market.</span> <span translate="no">{token.symbol}</span> is a test token with no value.
            </span>
          </span>
        )}
        {deployment &&
          token.hasFaucet &&
          (isConnected ? (
            <span className="flex flex-wrap items-center gap-2" aria-live="polite">
              <button className="btn btn-sm" disabled={faucet.busy || coolingDown} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
                Get {TEST_TOKEN ? "test " : ""}
                {token.symbol}
              </button>
              {coolingDown && <span className="text-muted">Next top-up after {fmtTime(waitUntil)}</span>}
              <FaucetStatus state={faucet.state} />
            </span>
          ) : (
            <span className="text-muted">
              {mode === "privy" ? "Sign in" : "Connect a wallet"} to get {token.symbol} from the faucet.
            </span>
          ))}
        {!sponsored && GAS_FAUCET_URL && (
          <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted underline decoration-line-strong underline-offset-[3px] hover:text-ink hover:decoration-accent">
            {NATIVE_SYMBOL} for fees <IconExternal className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

/** A sealed box: an outlined square whose corner is filled in the accent. */
function Logo() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" aria-hidden>
      <rect x="1.75" y="1.75" width="16.5" height="16.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10h8.25v5.25a3 3 0 01-3 3H10V10z" fill="var(--accent)" />
    </svg>
  );
}

/** wagmi mode (local anvil only): browser wallets, burner keys and a per-session account switcher. */
function WagmiWalletButton() {
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !ref.current?.contains(document.activeElement)) return;
      setOpen(false);
      triggerRef.current?.focus(); // return focus to the control that opened the panel
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  // move keyboard focus into the panel when it opens
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("button, a[href], summary, input")?.focus();
  }, [open]);

  if (!mounted)
    return (
      <button className="btn btn-sm opacity-0" aria-hidden tabIndex={-1}>
        Connect wallet
      </button>
    );

  const wrongChain = isConnected && chainId !== CHAIN_ID;
  const uniq = connectors.filter((c, i, arr) => c.id !== BURNER_CONNECTOR_ID && arr.findIndex((x) => x.name === c.name) === i);
  const hasClaim = (claimable.data ?? 0n) > 0n;

  return (
    <div className="relative" ref={ref}>
      {!isConnected ? (
        <button className="btn btn-sm" ref={triggerRef} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={isPending}>
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
      ) : wrongChain ? (
        <button className="btn btn-sm border-warn text-warn" onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={switching}>
          {switching ? "Switching…" : "Switch network"}
        </button>
      ) : (
        <button className="btn btn-sm" ref={triggerRef} aria-haspopup="dialog" aria-expanded={open} aria-label={`Account menu${hasClaim ? ", you have funds to withdraw" : ""}`} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", hasClaim ? "bg-warn" : "bg-ok")} />
          <span className="font-mono tabular-nums">{bal !== undefined ? fmtUsdc(bal as bigint) : shortAddr(address)}</span>
        </button>
      )}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={isConnected ? "Your account" : "Connect a wallet"}
          className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] overscroll-contain rounded-md bg-panel p-2 [box-shadow:var(--overlay-shadow)]"
        >
          {!isConnected ? (
            <>
              <p className="px-2 pt-1 pb-2 text-xs leading-relaxed text-muted">Browsing needs no wallet. You need one to buy, report a problem, release a payment, rate, or withdraw.</p>
              {uniq.map((c) => (
                <button
                  key={c.uid}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left text-sm transition-colors duration-150 hover:bg-panel-2"
                  onClick={() => {
                    connect({ connector: c, chainId: CHAIN_ID });
                    setOpen(false);
                  }}
                >
                  {c.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.icon} alt="" width={20} height={20} className="h-5 w-5 rounded" />
                  ) : (
                    <span aria-hidden className="h-5 w-5 rounded border border-line bg-panel-2" />
                  )}
                  {c.name === "Injected" ? "Browser wallet (MetaMask, Rabby…)" : c.name}
                </button>
              ))}
              {error && <p className="px-2 pt-1 text-xs text-bad">{error.message.split("\n")[0]}</p>}
              <div className="mt-2 space-y-2 border-t border-line px-2 pt-2 pb-1">
                <div className="section-title">Burner key · dev tool</div>
                <BurnerSwitcher onSwitch={() => setOpen(false)} />
                <BurnerForm onDone={() => setOpen(false)} />
              </div>
            </>
          ) : (
            <div className="space-y-2 p-1 text-sm">
              <div className="px-1">
                <div className="text-xs text-muted">Connected with {connector?.name}</div>
                <div className="font-mono text-xs [overflow-wrap:anywhere]" translate="no">
                  {address}
                </div>
              </div>
              <BurnerSwitcher />
              <details className="rounded border border-line px-2 py-1.5 text-xs">
                <summary className="cursor-pointer text-muted">Add a burner key (switch perspective)</summary>
                <div className="mt-2">
                  <BurnerForm />
                </div>
              </details>
              <AccountPanel onClose={() => setOpen(false)} />
              <div className="border-t border-line pt-1">
                <button
                  className="w-full cursor-pointer rounded px-1 py-1.5 text-left text-bad transition-colors duration-150 hover:bg-panel-2"
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
  const token = useTokenInfo();
  return (
    <footer className="border-t border-line pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="leading-relaxed">
          <span className="font-medium text-ink">RL Environment Market</span> · {CHAIN_NAME}
          {TEST_TOKEN && (
            <>
              , <span translate="no">{token.symbol}</span> has no value
            </>
          )}
        </p>
        <nav aria-label="Footer" className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2">
          {TEE_TRUST_URL && (
            <a href={TEE_TRUST_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
              TEE attestation <IconExternal className="h-3 w-3" />
            </a>
          )}
          <Link href="/keys" className="hover:text-ink">
            Delivery keys
          </Link>
          {deployment && (
            <details className="group">
              <summary className="cursor-pointer list-none hover:text-ink [&::-webkit-details-marker]:hidden">Contracts</summary>
              <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span>Market</span>
                  <AddressLink address={deployment.market} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Payment token</span>
                  <AddressLink address={deployment.token} />
                </div>
              </div>
            </details>
          )}
        </nav>
      </div>
    </footer>
  );
}

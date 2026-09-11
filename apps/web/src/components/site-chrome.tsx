"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { CHAIN_ID, CHAIN_NAME, deployment, TEE_URL, addressUrl, IS_MAINNET, GAS_FAUCET_URL } from "@/lib/config";
import { tokenAbi } from "@/lib/abi";
import { BURNER_CONNECTOR_ID } from "@/lib/burner";
import { fmtTime, fmtUsdc, shortAddr } from "@/lib/format";
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
  { href: "/keys", label: "My Keys" },
  { href: "/how-it-works", label: "How It Works" },
];

export function SiteHeader() {
  const path = usePathname();
  const { mode, devTools, privyConfigured } = useWalletMode();
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
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={cx(
                "relative flex items-center px-2.5 text-[13px] transition-colors duration-150",
                isActive(n.href)
                  ? "font-medium text-ink after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:bg-accent"
                  : "text-muted hover:text-ink",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span
            className="hidden h-7 items-center gap-2 rounded-md border border-line px-2.5 font-mono text-[11px] text-muted sm:inline-flex"
            title={deployment ? `Contracts deployed on chain ${CHAIN_ID}` : `No deployment for chain ${CHAIN_ID}`}
          >
            <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", deployment ? "bg-ok" : "bg-warn")} />
            {CHAIN_NAME}
            {IS_MAINNET && <span className="font-semibold text-warn uppercase">mainnet</span>}
            {devTools && <span className="border-l border-line pl-2 text-accent uppercase">dev tools</span>}
          </span>
          {mode === "privy" ? <PrivyWalletButton /> : <WagmiWalletButton />}
        </div>
      </div>
      <nav aria-label="Primary" className="flex gap-1 overflow-x-auto border-t border-line px-2 md:hidden [scrollbar-width:none]">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(n.href) ? "page" : undefined}
            className={cx(
              "relative flex h-10 items-center px-2.5 text-[13px] whitespace-nowrap",
              isActive(n.href) ? "font-medium text-ink after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:bg-accent" : "text-muted",
            )}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      {!IS_MAINNET && <TestnetBanner />}
      {!privyConfigured && !devTools && (
        <div className="border-t border-line bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-1.5 text-xs text-muted sm:px-6">
            Email / Google login (Privy) is not configured for this deployment: set <code className="font-mono text-ink">NEXT_PUBLIC_PRIVY_APP_ID</code> (see apps/web/README.md). Browser wallets still work.
          </div>
        </div>
      )}
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
    <div className="border-t border-line bg-panel">
      <div className="mx-auto flex min-h-9 max-w-6xl flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-1.5 text-xs sm:px-6">
        <span className="inline-flex items-center gap-2">
          <span className="badge badge-warn font-mono tracking-wide uppercase">Testnet</span>
          <span className="text-muted">
            {CHAIN_NAME} · <span translate="no">{token.symbol}</span> has no value
          </span>
        </span>
        {deployment &&
          token.hasFaucet &&
          (isConnected ? (
            <span className="flex flex-wrap items-center gap-2">
              <button className="btn btn-sm" disabled={faucet.busy || coolingDown} onClick={() => faucet.run("Faucet", { address: deployment!.token, abi: tokenAbi, functionName: "faucet" })}>
                Get Test {token.symbol}
              </button>
              {coolingDown && <span className="text-muted">Faucet used; available again {fmtTime(waitUntil)}</span>}
              <TxStatus state={faucet.state} />
            </span>
          ) : (
            <span className="text-muted">
              {mode === "privy" ? "Log in (top right)" : "Connect a wallet"} to get test {token.symbol} from the faucet.
            </span>
          ))}
        {sponsored ? (
          <span className="text-muted">Gas is sponsored for wallets created at login.</span>
        ) : (
          GAS_FAUCET_URL && (
            <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 text-muted">
              Base Sepolia ETH for gas <IconExternal className="h-3 w-3" />
            </a>
          )
        )}
      </div>
    </div>
  );
}

/** A sealed box: an outlined square whose corner is filled in the accent — the bundle you buy without opening. */
function Logo() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" aria-hidden>
      <rect x="1.75" y="1.75" width="16.5" height="16.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10h8.25v5.25a3 3 0 01-3 3H10V10z" fill="var(--accent)" />
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
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  if (!mounted)
    return (
      <button className="btn btn-sm opacity-0" aria-hidden tabIndex={-1}>
        Connect Wallet
      </button>
    );

  const wrongChain = isConnected && chainId !== CHAIN_ID;
  const uniq = connectors.filter((c, i, arr) => c.id !== BURNER_CONNECTOR_ID && arr.findIndex((x) => x.name === c.name) === i);
  const hasClaim = (claimable.data ?? 0n) > 0n;

  return (
    <div className="relative" ref={ref}>
      {!isConnected ? (
        <button className="btn btn-primary btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={isPending}>
          {isPending ? "Connecting…" : "Connect Wallet"}
        </button>
      ) : wrongChain ? (
        <button className="btn btn-sm border-warn text-warn" onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={switching}>
          {switching ? "Switching…" : `Switch to ${CHAIN_NAME}`}
        </button>
      ) : (
        <button className="btn btn-sm" aria-haspopup="menu" aria-expanded={open} aria-label={`Account ${address}${hasClaim ? ", funds to withdraw" : ""}`} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", hasClaim ? "bg-warn" : "bg-ok")} />
          <span className="font-mono" translate="no">
            {shortAddr(address)}
          </span>
          {bal !== undefined && <span className="hidden border-l border-line pl-2 font-mono text-muted tabular-nums sm:inline">{fmtUsdc(bal as bigint)}</span>}
        </button>
      )}
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] overscroll-contain rounded-md bg-panel p-2 [box-shadow:var(--overlay-shadow)]">
          {!isConnected ? (
            <>
              <p className="px-2 pt-1 pb-2 text-xs text-muted">
                Connect a wallet on {CHAIN_NAME}. Browsing is read-only; a wallet is only needed to buy, dispute, finalize, rate, or withdraw.
              </p>
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
              {devTools && (
                <div className="mt-2 space-y-2 border-t border-line px-2 pt-2 pb-1">
                  <div className="section-title">Burner key · dev tool</div>
                  <BurnerSwitcher onSwitch={() => setOpen(false)} />
                  <BurnerForm onDone={() => setOpen(false)} />
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2 p-1 text-sm">
              <div>
                <div className="text-xs text-muted">Connected with {connector?.name}</div>
                <div className="font-mono text-xs [overflow-wrap:anywhere]" translate="no">
                  {address}
                </div>
              </div>
              {devTools && (
                <>
                  <BurnerSwitcher />
                  <details className="rounded border border-line px-2 py-1.5 text-xs">
                    <summary className="cursor-pointer text-muted">Add a burner key (switch perspective)</summary>
                    <div className="mt-2">
                      <BurnerForm />
                    </div>
                  </details>
                </>
              )}
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
  useTokenInfo();
  return (
    <footer className="border-t border-line pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-xs text-muted sm:grid-cols-3 sm:px-6">
        <div className="space-y-2">
          <div className="section-title text-ink">RL Environment Market</div>
          <p className="leading-relaxed">
            Running on {CHAIN_NAME} (chain {CHAIN_ID}). {tokenValueNote()}
          </p>
          <p>
            <Link href="/how-it-works" className="link">
              Trust assumptions &amp; what is real
            </Link>
          </p>
        </div>
        <div className="space-y-2">
          <div className="section-title text-ink">Contracts</div>
          {deployment ? (
            <>
              <FooterAddr label="EnvMarket" addr={deployment.market} />
              <FooterAddr label="Payment token" addr={deployment.token} />
              <div>
                Events indexed from block <span className="font-mono tabular-nums">{deployment.startBlock.toString()}</span>
              </div>
            </>
          ) : (
            <div>Not deployed on this chain yet.</div>
          )}
        </div>
        <div className="space-y-2">
          <div className="section-title text-ink">TEE Service</div>
          {TEE_URL ? (
            <a href={`${TEE_URL}/health`} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 font-mono [overflow-wrap:anywhere]" translate="no">
              {TEE_URL} <IconExternal className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <div>
              <code className="font-mono">NEXT_PUBLIC_TEE_URL</code> not configured.
            </div>
          )}
          <p className="leading-relaxed">Every value on this site is read live from the chain or the TEE service and checked in your browser; nothing is simulated.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterAddr({ label, addr }: { label: string; addr: string }) {
  const u = addressUrl(addr);
  return (
    <div className="flex items-center justify-between gap-3 sm:justify-start">
      <span>{label}</span>
      {u ? (
        <a className="link inline-flex items-center gap-1 font-mono" href={u} target="_blank" rel="noreferrer" translate="no" title={addr}>
          {shortAddr(addr)} <IconExternal className="h-3 w-3" />
        </a>
      ) : (
        <span className="font-mono" translate="no" title={addr}>
          {shortAddr(addr)}
        </span>
      )}
    </div>
  );
}

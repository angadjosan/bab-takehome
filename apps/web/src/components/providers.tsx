"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { createConfig as createPrivyWagmiConfig, WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from "react";
import { parseAbi, zeroAddress } from "viem";
import { createConfig, http, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { chain, deployment, RPC_URL } from "@/lib/config";
import { publicClient } from "@/lib/client";
import { burner } from "@/lib/burner";
import { setTokenMeta, tokenMeta } from "@/lib/token";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID, useDevTools } from "@/lib/wallet-mode";
import { PrivySponsorBridge } from "./privy-login";

/* ------------------------------------ wallet mode ------------------------------------ */

export type WalletMode = { mode: "privy" | "wagmi"; devTools: boolean; privyConfigured: boolean };
const ModeCtx = createContext<WalletMode>({ mode: "wagmi", devTools: false, privyConfigured: false });
/** "privy": Privy login + embedded wallet (default). "wagmi": dev tools (burner keys) or Privy not configured. */
export const useWalletMode = () => useContext(ModeCtx);

/* ------------------------------------ token meta ------------------------------------ */

const metaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function faucetAvailableAt(address) view returns (uint256)",
]);

const tokenGetterAbi = parseAbi(["function token() view returns (address)"]);

const TokenCtx = createContext(0);

/** Token metadata as read from the payment-token contract (re-renders consumers when loaded). */
export function useTokenInfo() {
  useContext(TokenCtx);
  return tokenMeta;
}

/**
 * Reads symbol/decimals from the deployed token and whether it exposes a faucet (the TestUSDC used on
 * testnets and anvil does). If symbol or decimals differ from the first-paint defaults the subtree is
 * remounted so every formatted amount picks them up.
 */
function TokenMeta({ children }: { children: ReactNode }) {
  const [ver, setVer] = useState(0);
  const [remount, setRemount] = useState(0);
  useEffect(() => {
    if (!deployment) return;
    let cancelled = false;
    (async () => {
      // The market's own token() is authoritative; the deployment file is only a first guess.
      let tokenChanged = false;
      try {
        const onchain = (await publicClient.readContract({ address: deployment!.market, abi: tokenGetterAbi, functionName: "token" })) as `0x${string}`;
        if (onchain && onchain.toLowerCase() !== deployment!.token.toLowerCase()) {
          deployment!.token = onchain;
          tokenChanged = true;
        }
      } catch {
        /* market unreachable; keep the deployment file's value */
      }
      const r = (fn: "symbol" | "decimals" | "name") =>
        publicClient.readContract({ address: deployment!.token, abi: metaAbi, functionName: fn }).catch(() => undefined);
      const [symbol, decimals, name] = await Promise.all([r("symbol"), r("decimals"), r("name")]);
      let hasFaucet = false;
      try {
        await publicClient.readContract({ address: deployment!.token, abi: metaAbi, functionName: "faucetAvailableAt", args: [zeroAddress] });
        hasFaucet = true;
      } catch {
        hasFaucet = false;
      }
      if (cancelled) return;
      const next = {
        symbol: typeof symbol === "string" && symbol ? symbol : tokenMeta.symbol,
        decimals: decimals === undefined ? tokenMeta.decimals : Number(decimals),
        name: typeof name === "string" ? name : "",
      };
      const changed = tokenChanged || next.symbol !== tokenMeta.symbol || next.decimals !== tokenMeta.decimals;
      setTokenMeta({ ...next, hasFaucet, loaded: true });
      if (changed) setRemount((x) => x + 1);
      setVer((x) => x + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <TokenCtx.Provider value={ver}>
      <Fragment key={remount}>{children}</Fragment>
    </TokenCtx.Provider>
  );
}

/* ------------------------------------ provider trees ------------------------------------ */

const transports = { [chain.id]: http(RPC_URL) };

/** Privy: login with email / Google / external wallet; an embedded wallet is created on login. */
function PrivyTree({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  const [config] = useState(() => createPrivyWagmiConfig({ chains: [chain], transports, ssr: true }));
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID || undefined}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [chain],
        appearance: { theme: "light", accentColor: "#4f46e5" },
      }}
    >
      <QueryClientProvider client={qc}>
        <PrivyWagmiProvider config={config}>
          <PrivySponsorBridge>{children}</PrivySponsorBridge>
        </PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}

/** Plain wagmi: browser wallets, plus the burner-key connector when dev tools are on. */
function WagmiTree({ qc, devTools, children }: { qc: QueryClient; devTools: boolean; children: ReactNode }) {
  const [config] = useState(() =>
    createConfig({
      chains: [chain],
      connectors: [injected({ shimDisconnect: true }), coinbaseWallet({ appName: "RL Environment Market" }), ...(devTools ? [burner()] : [])],
      transports,
      ssr: true,
    }),
  );
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const devTools = useDevTools();
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  const mode: WalletMode["mode"] = PRIVY_APP_ID && !devTools ? "privy" : "wagmi";
  const inner = <TokenMeta>{children}</TokenMeta>;
  return (
    <ModeCtx.Provider value={{ mode, devTools, privyConfigured: !!PRIVY_APP_ID }}>
      {mode === "privy" ? (
        <PrivyTree qc={qc}>{inner}</PrivyTree>
      ) : (
        // keyed so turning dev tools on (?dev=1) rebuilds the wagmi config with the burner connector
        <WagmiTree key={devTools ? "dev" : "std"} qc={qc} devTools={devTools}>
          {inner}
        </WagmiTree>
      )}
    </ModeCtx.Provider>
  );
}

"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { createConfig as createPrivyWagmiConfig, WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from "react";
import { parseAbi, zeroAddress } from "viem";
import { createConfig, http, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { chain, CHAIN_ID, deployment, RPC_URL } from "@/lib/config";
import { publicClient } from "@/lib/client";
import { burner } from "@/lib/burner";
import { setTokenMeta, tokenMeta } from "@/lib/token";
import { DEV_TOOLS, PRIVY_APP_ID, PRIVY_CLIENT_ID, PRIVY_CREATE_ON_LOGIN, PRIVY_LOGIN_METHODS } from "@/lib/wallet-mode";
import { PrivySponsorBridge } from "./privy-login";

/* ------------------------------------ wallet mode ------------------------------------ */

export type WalletMode = { mode: "privy" | "wagmi"; devTools: boolean; privyConfigured: boolean };
const MODE: WalletMode = { mode: DEV_TOOLS ? "wagmi" : "privy", devTools: DEV_TOOLS, privyConfigured: !!PRIVY_APP_ID };
const ModeCtx = createContext<WalletMode>(MODE);
/**
 * "privy": every chain except local anvil (Privy login + embedded wallet). With `privyConfigured` false
 * no Privy provider is mounted and sign-in renders disabled. "wagmi": local anvil only (browser wallets
 * plus burner keys, `devTools` true).
 */
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

/** Privy: login with email or an external wallet (the methods enabled in the Privy dashboard); an embedded wallet is created on email login. */
function PrivyTree({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  const [config] = useState(() => createPrivyWagmiConfig({ chains: [chain], transports, ssr: true }));
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID || undefined}
      config={{
        loginMethods: PRIVY_LOGIN_METHODS,
        embeddedWallets: { ethereum: { createOnLogin: PRIVY_CREATE_ON_LOGIN } },
        defaultChain: chain,
        supportedChains: [chain],
        appearance: { theme: "dark", accentColor: "#f59e0b" },
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

/**
 * Plain wagmi. On local anvil (`dev`): browser wallets plus the burner-key connector. On a hosted build
 * without a Privy app id: no connectors at all (reads still work, nobody can sign in).
 */
function WagmiTree({ qc, dev, children }: { qc: QueryClient; dev: boolean; children: ReactNode }) {
  const [config] = useState(() =>
    createConfig({
      chains: [chain],
      connectors: dev ? [injected({ shimDisconnect: true }), coinbaseWallet({ appName: "RL Environment Market" }), burner()] : [],
      multiInjectedProviderDiscovery: dev,
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
  useEffect(() => {
    if (MODE.mode === "privy" && !MODE.privyConfigured) {
      console.error(`NEXT_PUBLIC_PRIVY_APP_ID is not set for this build (chain ${CHAIN_ID}), so sign-in is disabled. Set it in the deployment environment and rebuild.`);
    }
  }, []);
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  const inner = <TokenMeta>{children}</TokenMeta>;
  return (
    <ModeCtx.Provider value={MODE}>
      {MODE.mode === "privy" && MODE.privyConfigured ? (
        <PrivyTree qc={qc}>{inner}</PrivyTree>
      ) : (
        <WagmiTree qc={qc} dev={MODE.devTools}>
          {inner}
        </WagmiTree>
      )}
    </ModeCtx.Provider>
  );
}

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from "react";
import { parseAbi, zeroAddress } from "viem";
import { createConfig, http, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { chain, deployment, RPC_URL } from "@/lib/config";
import { publicClient } from "@/lib/client";
import { setTokenMeta, tokenMeta } from "@/lib/token";

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected({ shimDisconnect: true }), coinbaseWallet({ appName: "RL Environment Market" })],
  transports: { [chain.id]: http(RPC_URL) },
  ssr: true,
});

const metaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function faucetAvailableAt(address) view returns (uint256)",
]);

const TokenCtx = createContext(0);

/** Token metadata as read from the payment-token contract (re-renders consumers when loaded). */
export function useTokenInfo() {
  useContext(TokenCtx);
  return tokenMeta;
}

/**
 * Reads symbol/decimals from the deployed token and whether it exposes a faucet (only the local
 * TestUSDC does). If symbol or decimals differ from the first-paint defaults the subtree is
 * remounted so every formatted amount picks them up.
 */
function TokenMeta({ children }: { children: ReactNode }) {
  const [ver, setVer] = useState(0);
  const [remount, setRemount] = useState(0);
  useEffect(() => {
    if (!deployment) return;
    let cancelled = false;
    (async () => {
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
      const changed = next.symbol !== tokenMeta.symbol || next.decimals !== tokenMeta.decimals;
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

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <TokenMeta>{children}</TokenMeta>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

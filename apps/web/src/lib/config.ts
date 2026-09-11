import { defineChain, getAddress, isAddress, zeroAddress, type Address, type Chain } from "viem";
import { base, baseSepolia, foundry } from "viem/chains";
import { generatedDeployments } from "@/generated/contracts";

/**
 * Chain selection. Everything chain-specific (RPC, explorer, token, addresses) derives from
 * NEXT_PUBLIC_CHAIN_ID. Supported: 84532 Base Sepolia (default: the public testnet deployment with
 * TestUSDC), 31337 local Anvil, and 8453 Base mainnet (supported, unused).
 */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 84532);
/** Gas for testnet users: Base Sepolia ETH faucets listed by Base. */
export const GAS_FAUCET_URL = CHAIN_ID === 84532 ? "https://docs.base.org/base-chain/tools/network-faucets" : null;

const DEFAULT_RPC: Record<number, string> = {
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
  31337: "http://127.0.0.1:8545",
};

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_RPC[CHAIN_ID] || "";
const PUBLIC_TEE_URL = (process.env.NEXT_PUBLIC_TEE_URL || "").replace(/\/+$/, "");
/**
 * Base URL the browser uses for the TEE API: the TEE itself when it is served over https, otherwise
 * this app's same-origin proxy (/api/tee → server-only TEE_URL). The EigenCompute TEE is plain http,
 * which an https page cannot call. Integrity never depends on the proxy: every document is hash-checked
 * against the chain in the browser.
 */
export const TEE_URL = /^https:\/\//.test(PUBLIC_TEE_URL) ? PUBLIC_TEE_URL : "/api/tee";
export const TEE_VIA_PROXY = TEE_URL === "/api/tee";
/**
 * The juror service: a separate Vercel project running the three AI jurors as durable workflows.
 * The app pings its POST /api/wake right after a dispute opens so jurors start immediately (the
 * service's own sweep catches anything missed). Empty string disables the ping.
 */
export const JURORS_URL = (process.env.NEXT_PUBLIC_JURORS_URL ?? (CHAIN_ID === 84532 ? "https://rl-env-market-jurors.vercel.app" : "")).replace(/\/+$/, "");

const KNOWN: Record<number, Chain> = { 8453: base, 84532: baseSepolia, 31337: foundry };
const baseChain: Chain =
  KNOWN[CHAIN_ID] ??
  defineChain({
    id: CHAIN_ID,
    name: `Chain ${CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

export const chain: Chain = { ...baseChain, rpcUrls: { ...baseChain.rpcUrls, default: { http: [RPC_URL] } } };

export const CHAIN_NAME = CHAIN_ID === 8453 ? "Base" : CHAIN_ID === 84532 ? "Base Sepolia" : CHAIN_ID === 31337 ? "Local Anvil" : chain.name;
/** Real money: mainnet USDC. Copy across the app changes accordingly. */
export const IS_MAINNET = CHAIN_ID === 8453;
export const IS_LOCAL = CHAIN_ID === 31337;

const EXPLORERS: Record<number, string> = { 8453: "https://basescan.org", 84532: "https://sepolia.basescan.org" };
export const EXPLORER: string | null = EXPLORERS[CHAIN_ID] ?? null;

export const txUrl = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : null);
export const addressUrl = (addr: string) => (EXPLORER ? `${EXPLORER}/address/${addr}` : null);
export const blockUrl = (n: bigint | number) => (EXPLORER ? `${EXPLORER}/block/${n}` : null);

export type Deployment = {
  chainId: number;
  market: Address;
  /**
   * Payment token. Taken from the deployment file when present; in all cases the
   * TokenMetaProvider replaces it with the market contract's own `token()` at startup, so the
   * address is never hardcoded in the app.
   */
  token: Address;
  startBlock: bigint;
  raw: Record<string, unknown>;
};

function pickAddress(obj: Record<string, unknown>, keys: string[]): Address | null {
  const scopes = [obj, (obj.contracts ?? {}) as Record<string, unknown>, (obj.addresses ?? {}) as Record<string, unknown>];
  for (const scope of scopes) {
    for (const k of keys) {
      const v = scope[k];
      if (typeof v === "string" && isAddress(v)) return getAddress(v);
      if (v && typeof v === "object" && typeof (v as { address?: unknown }).address === "string") {
        const a = (v as { address: string }).address;
        if (isAddress(a)) return getAddress(a);
      }
    }
  }
  return null;
}

/**
 * Explicit addresses from the environment win over the synced deployment file. Used by
 * scripts/local-stack.sh so a throwaway anvil deployment never lands in the committed
 * src/generated/contracts.ts.
 */
function envDeployment(): Deployment | null {
  const m = process.env.NEXT_PUBLIC_MARKET_ADDRESS;
  if (!m || !isAddress(m)) return null;
  const t = process.env.NEXT_PUBLIC_TOKEN_ADDRESS;
  const sb = process.env.NEXT_PUBLIC_START_BLOCK;
  return {
    chainId: CHAIN_ID,
    market: getAddress(m),
    token: t && isAddress(t) ? getAddress(t) : zeroAddress,
    startBlock: sb && /^\d+$/.test(sb) ? BigInt(sb) : 0n,
    raw: { source: "env" },
  };
}

function loadDeployment(): Deployment | null {
  const fromEnv = envDeployment();
  if (fromEnv) return fromEnv;
  const raw = generatedDeployments[String(CHAIN_ID)];
  if (!raw) return null;
  const market = pickAddress(raw, ["EnvMarket", "envMarket", "market", "Market"]);
  const token = pickAddress(raw, ["token", "TestUSDC", "testUSDC", "testUsdc", "USDC", "usdc"]) ?? zeroAddress;
  if (!market) return null;
  const sb = raw.startBlock ?? raw.deployBlock ?? raw.blockNumber ?? 0;
  return { chainId: CHAIN_ID, market, token, startBlock: BigInt(String(sb)), raw };
}

export const deployment = loadDeployment();

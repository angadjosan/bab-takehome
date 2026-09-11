import { defineChain, getAddress, isAddress, zeroAddress, type Address, type Chain } from "viem";
import { base, baseSepolia, foundry } from "viem/chains";
import { generatedDeployments } from "@/generated/contracts";

/**
 * Chain selection. Everything chain-specific (RPC, explorer, token, addresses) derives from
 * NEXT_PUBLIC_CHAIN_ID. Supported: 8453 Base mainnet (default, real USDC), 84532 Base Sepolia,
 * 31337 local Anvil.
 */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 8453);

const DEFAULT_RPC: Record<number, string> = {
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
  31337: "http://127.0.0.1:8545",
};

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_RPC[CHAIN_ID] || "";
export const TEE_URL = (process.env.NEXT_PUBLIC_TEE_URL || "").replace(/\/+$/, "");

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

function loadDeployment(): Deployment | null {
  const raw = generatedDeployments[String(CHAIN_ID)];
  if (!raw) return null;
  const market = pickAddress(raw, ["EnvMarket", "envMarket", "market", "Market"]);
  const token = pickAddress(raw, ["token", "TestUSDC", "testUSDC", "testUsdc", "USDC", "usdc"]) ?? zeroAddress;
  if (!market) return null;
  const sb = raw.startBlock ?? raw.deployBlock ?? raw.blockNumber ?? 0;
  return { chainId: CHAIN_ID, market, token, startBlock: BigInt(String(sb)), raw };
}

export const deployment = loadDeployment();

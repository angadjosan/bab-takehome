import { defineChain, getAddress, isAddress, zeroAddress, type Address, type Chain } from "viem";
import { base, baseSepolia, foundry } from "viem/chains";
import { generatedDeployments } from "@/generated/contracts";

/**
 * Chain selection. Everything chain-specific derives from NEXT_PUBLIC_CHAIN_ID, or, when it is unset,
 * from the single chain deployment synced into src/generated. Chain name, default RPC, explorer and
 * native-currency symbol come from viem's chain definitions and the deployment file; nothing is
 * mapped by hand here.
 */
const syncedChainIds = Object.keys(generatedDeployments).filter((k) => /^\d+$/.test(k));
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || (syncedChainIds.length === 1 ? syncedChainIds[0] : 0));

const KNOWN: Record<number, Chain> = { [base.id]: base, [baseSepolia.id]: baseSepolia, [foundry.id]: foundry };

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || KNOWN[CHAIN_ID]?.rpcUrls.default.http[0] || "";
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
 * The juror service (a separate Vercel project, NEXT_PUBLIC_JURORS_URL). The app pings its
 * POST /api/wake right after a dispute opens so jurors start immediately (the service's own sweep
 * catches anything missed). Unset disables the ping.
 */
export const JURORS_URL = (process.env.NEXT_PUBLIC_JURORS_URL ?? "").replace(/\/+$/, "");

const baseChain: Chain =
  KNOWN[CHAIN_ID] ??
  defineChain({
    id: CHAIN_ID,
    name: `Chain ${CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

export const chain: Chain = { ...baseChain, rpcUrls: { ...baseChain.rpcUrls, default: { http: [RPC_URL] } } };

/** Display name of the chain, from viem's chain definition. */
export const CHAIN_NAME = chain.name;
/** Symbol of the chain's gas currency, from viem's chain definition. */
export const NATIVE_SYMBOL = chain.nativeCurrency.symbol;
export const IS_LOCAL = CHAIN_ID === foundry.id;

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

/** The deployment file marks the payment token as a valueless test token (`testToken: true`). */
export const TEST_TOKEN = deployment?.raw.testToken === true;

const str = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v.replace(/\/+$/, "") : null);
const deploymentExplorer = Array.isArray(deployment?.raw.explorers) ? str((deployment!.raw.explorers as { base?: unknown }[])[0]?.base) : null;

/** Block explorer: the deployment file's first explorer, else viem's default for the chain. */
export const EXPLORER: string | null = deploymentExplorer ?? str(chain.blockExplorers?.default.url);

export const txUrl = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : null);
export const addressUrl = (addr: string) => (EXPLORER ? `${EXPLORER}/address/${addr}` : null);
export const blockUrl = (n: bigint | number) => (EXPLORER ? `${EXPLORER}/block/${n}` : null);

/** Where to get gas on a test chain: NEXT_PUBLIC_GAS_FAUCET_URL, or the deployment file's `gasFaucetUrl`. None otherwise. */
export const GAS_FAUCET_URL: string | null = str(process.env.NEXT_PUBLIC_GAS_FAUCET_URL) ?? str(deployment?.raw.gasFaucetUrl);

/** Public attestation page of the TEE serving this market, from the synced TEE deployment record. */
const teeRecord = generatedDeployments["phala-tee"] as Record<string, unknown> | undefined;
export const TEE_TRUST_URL: string | null =
  teeRecord && Number(teeRecord.chainId) === CHAIN_ID && deployment && typeof teeRecord.market === "string" && teeRecord.market.toLowerCase() === deployment.market.toLowerCase()
    ? str(teeRecord.trustUrl)
    : null;

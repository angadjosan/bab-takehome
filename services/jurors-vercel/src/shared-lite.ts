/**
 * What the vendored juror modules import from `@envmarket/shared` (tsconfig/vitest alias).
 * Only these pieces are needed on Vercel, so the full shared package (tar, HPKE, Merkle, dotenv,
 * repo-root discovery, fs-based ABI loading) is not bundled. The re-exported modules are byte-for-
 * byte copies of packages/shared/src (see scripts/sync-vendor.mjs).
 */
import type { Abi, Chain, LocalAccount, PublicClient, Transport, WalletClient } from 'viem';
import envMarketAbi from './vendor/shared/abi/EnvMarket.json';

export { evidenceAuthMessage, signEvidenceAuth, verifyEvidenceAuth } from './vendor/shared/eip712.ts';
export {
  FIREWORKS_BASE_URL,
  isFireworks,
  LlmClient,
  OLLAMA_BASE_URL,
  pickNewestModels,
  type ChatMessage,
  type ChatResult,
  type LlmConfig,
  type ProviderModel,
} from './vendor/shared/llm.ts';

/** Same shape as packages/shared `Clients` minus the repo EnvConfig (unused by the vendored code). */
export interface Clients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, LocalAccount>;
  account: LocalAccount;
  chain: Chain;
}

const ABIS: Record<string, Abi> = {
  EnvMarket: (Array.isArray(envMarketAbi) ? envMarketAbi : (envMarketAbi as { abi: Abi }).abi) as Abi,
};

/** Bundled replacement for packages/shared `loadAbi` (which reads src/abi/*.json from disk). */
export function loadAbi(name: string): Abi {
  const abi = ABIS[name];
  if (!abi) throw new Error(`ABI ${name} is not bundled in jurors-vercel`);
  return abi;
}

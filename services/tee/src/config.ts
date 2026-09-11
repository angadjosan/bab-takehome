/**
 * Service configuration (env vars; repo-root .env is read in local dev via @envmarket/shared).
 *
 * Chain:      CHAIN_ID, RPC_URL | BASE_RPC | ANVIL_RPC, MARKET_ADDRESS, START_BLOCK (or deployments/<chainId>.json)
 * Vendor:     TEE_VENDOR = eigencompute | phala | local (auto: MNEMONIC → eigencompute;
 *             /var/run/dstack.sock → phala; else local). DSTACK_SIMULATOR_ENDPOINT for tests.
 * Keys:       MNEMONIC (EigenCompute KMS) | dstack GetKey (Phala) | RUNNER_PK (local dev only)
 * HTTP:       PORT (default 8080), HOST (0.0.0.0), PUBLIC_URL (base URL advertised in listings)
 * Storage:    DATA_DIR (default ./.data)
 * Inference:  FIREWORKS_API_KEY (provider "fireworks", https://api.fireworks.ai/inference/v1)
 *             LLM_PROVIDER=ollama for the local harness check (OLLAMA_BASE_URL, LOCAL_AGENT_MODEL,
 *             LOCAL_VALIDATOR_MODEL) — never used in eigencompute mode.
 *             VALIDATOR_MODEL (optional exact id; else newest deepseek / gpt-oss on the provider)
 * Behaviour:  SUBMIT_TXS (default 1), WATCHER (default 1), POLL_MS, PREVIEW_CONCURRENCY,
 *             EPISODE_TIME_SEC, SANDBOX (auto|docker|unshare), SANDBOX_IMAGE,
 *             PREVIEW_RATE_PER_LISTING_PER_HOUR, PREVIEW_RATE_GLOBAL_PER_HOUR
 * Attestation: KMS_SERVER_URL, KMS_PUBLIC_KEY (injected by EigenCompute), EIGEN_APP_ID,
 *             EIGEN_IMAGE_DIGEST, EIGEN_ENVIRONMENT, EIGEN_VERIFY_URL
 */
import * as path from 'node:path';
import { loadEnv, type EnvConfig } from '@envmarket/shared';
import type { Address } from 'viem';
import { teeVendor, type TeeVendor } from './keys.ts';

export type LlmProviderName = 'fireworks' | 'ollama' | 'openai-compatible';

export interface LlmConfig {
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string | null;
  /** exact model ids to use for the local harness check (ollama) */
  localAgentModel: string;
  localValidatorModel: string;
  validatorModel: string | null;
}

export interface ServiceConfig {
  vendor: TeeVendor;
  keyMode: 'eigencompute' | 'phala' | 'local-dev';
  env: EnvConfig;
  rawEnv: Record<string, string>;
  chainId: number;
  rpcUrl: string;
  market: Address | null;
  startBlock: bigint;
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  repoRoot: string | null;
  submitTxs: boolean;
  watcher: boolean;
  pollMs: number;
  llm: LlmConfig;
  preview: {
    concurrency: number;
    actionBudget: number;
    episodeTimeSec: number;
    maxTokens: number;
    seed: number;
    temperature: number;
    ratePerListingPerHour: number;
    rateGlobalPerHour: number;
  };
  sandbox: { mode: 'auto' | 'docker' | 'unshare'; image: string | null };
}

const truthy = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

export function loadConfig(overrides: Partial<Record<string, string>> = {}): ServiceConfig {
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
  const env = loadEnv({});
  const e = env.env;
  const vendor = teeVendor(e);
  const keyMode = vendor === 'local' ? 'local-dev' : vendor;
  // local dev default 8787 (agents' TEE_URL default); the Docker image sets PORT=8080 (Phala / EigenCompute)
  const port = Number(e.PORT ?? 8787);
  const provider = (e.LLM_PROVIDER as LlmProviderName | undefined) ?? (e.FIREWORKS_API_KEY ? 'fireworks' : 'fireworks');
  if (keyMode !== 'local-dev' && provider === 'ollama') throw new Error('LLM_PROVIDER=ollama is a local-dev harness check only');
  // Phala gateway URL (https://<app_id>-<port>.<gateway domain>) when the CVM exposes both values
  const phalaUrl = vendor === 'phala' && e.DSTACK_APP_ID && e.DSTACK_GATEWAY_DOMAIN ? `https://${e.DSTACK_APP_ID}-${port}.${e.DSTACK_GATEWAY_DOMAIN}` : null;
  const baseUrl =
    e.LLM_BASE_URL ?? (provider === 'fireworks' ? FIREWORKS_BASE_URL : provider === 'ollama' ? (e.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1') : '');
  return {
    vendor,
    keyMode,
    env,
    rawEnv: e,
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    market: env.addresses.market,
    startBlock: env.startBlock,
    port,
    host: e.HOST ?? '0.0.0.0',
    publicUrl: (e.PUBLIC_URL ?? phalaUrl ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir: path.resolve(e.DATA_DIR ?? '.data'),
    repoRoot: env.repoRoot,
    submitTxs: truthy(e.SUBMIT_TXS, true),
    watcher: truthy(e.WATCHER, true),
    pollMs: Number(e.POLL_MS ?? (env.chainId === 31337 ? 1000 : 4000)),
    llm: {
      provider,
      baseUrl,
      apiKey: provider === 'fireworks' ? (e.FIREWORKS_API_KEY ?? null) : (e.LLM_API_KEY ?? null),
      localAgentModel: e.LOCAL_AGENT_MODEL ?? 'gpt-oss:20b',
      localValidatorModel: e.LOCAL_VALIDATOR_MODEL ?? 'gemma4:latest',
      validatorModel: e.VALIDATOR_MODEL ?? null,
    },
    preview: {
      concurrency: Number(e.PREVIEW_CONCURRENCY ?? (provider === 'ollama' ? 1 : 6)),
      actionBudget: 12,
      episodeTimeSec: Number(e.EPISODE_TIME_SEC ?? (provider === 'ollama' ? 600 : 300)),
      maxTokens: Number(e.MAX_TOKENS ?? 8192),
      seed: 1337,
      temperature: 0,
      ratePerListingPerHour: Number(e.PREVIEW_RATE_PER_LISTING_PER_HOUR ?? 3),
      rateGlobalPerHour: Number(e.PREVIEW_RATE_GLOBAL_PER_HOUR ?? 12),
    },
    sandbox: { mode: (e.SANDBOX as 'auto' | 'docker' | 'unshare' | undefined) ?? 'auto', image: e.SANDBOX_IMAGE ?? null },
  };
}

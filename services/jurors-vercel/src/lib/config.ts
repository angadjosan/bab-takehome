/**
 * Service configuration from the Vercel environment. Server-only (steps and route handlers).
 *
 *   JUROR1_PK..JUROR3_PK  juror wallet keys (Vercel *sensitive* env vars; never logged or returned)
 *   FIREWORKS_API_KEY     inference (sensitive)
 *   JURORS_ENABLED        "1" to let workflows send transactions; anything else = dry run
 *   CHAIN_ID              default 84532 (Base Sepolia); 31337 for local anvil tests
 *   RPC_URL               default BASE_SEPOLIA_RPC or https://sepolia.base.org
 *   MARKET_ADDRESS / START_BLOCK   default from the vendored deployments/84532.json
 *   TEE_URL               default: the live Phala TEE
 *   KEEPER_JUROR          which juror key pays for keeper txs (selectJurors/tallyDispute), default 1
 *   ALLOWED_ORIGINS       CORS allowlist for POST /api/wake (comma separated)
 *   CRON_SECRET           bearer secret Vercel Cron sends to /api/cron/sweep
 */
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { anvil, baseSepolia } from 'viem/chains';
import type { Clients } from '../shared-lite.ts';
import deployment from '../vendor/deployments/84532.json';

export const LIVE_TEE_URL = 'https://4099f96ab07de8666f8a63a0f48e40aa9883eda3-8080.dstack-pha-prod5.phala.network';
export const DEFAULT_ALLOWED_ORIGINS = ['https://rl-env-market.vercel.app', 'http://localhost:3100'];
export const JUROR_INDICES = [1, 2, 3] as const;

type Env = Record<string, string | undefined>;

export interface ServiceConfig {
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  market: Address;
  startBlock: bigint;
  teeUrl: string;
  enabled: boolean;
  keeperIndex: number;
  allowedOrigins: string[];
}

const CHAINS: Record<number, Chain> = { [baseSepolia.id]: baseSepolia, [anvil.id]: anvil };

export function loadConfig(env: Env = process.env): ServiceConfig {
  const chainId = Number(env.CHAIN_ID ?? deployment.chainId);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`unsupported CHAIN_ID ${chainId}`);
  const useRecord = chainId === deployment.chainId;
  const marketRaw = env.MARKET_ADDRESS ?? (useRecord ? deployment.market : undefined);
  if (!marketRaw) throw new Error('MARKET_ADDRESS is required off Base Sepolia');
  const keeperIndex = Number(env.KEEPER_JUROR ?? 1);
  if (!JUROR_INDICES.includes(keeperIndex as 1)) throw new Error('KEEPER_JUROR must be 1, 2 or 3');
  return {
    chainId,
    chain,
    rpcUrl: env.RPC_URL ?? (chainId === baseSepolia.id ? (env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org') : 'http://127.0.0.1:8545'),
    market: getAddress(marketRaw),
    startBlock: BigInt(env.START_BLOCK ?? (useRecord ? deployment.startBlock : 0)),
    teeUrl: (env.TEE_URL ?? LIVE_TEE_URL).replace(/\/+$/, ''),
    enabled: /^(1|true|yes|on)$/i.test(env.JURORS_ENABLED ?? ''),
    keeperIndex,
    allowedOrigins: (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : DEFAULT_ALLOWED_ORIGINS).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  };
}

/** The juror's private key, normalized. Throws (without echoing the value) if missing or malformed. */
export function jurorKey(index: number, env: Env = process.env): Hex {
  const raw = env[`JUROR${index}_PK`];
  if (!raw) throw new Error(`JUROR${index}_PK is not set`);
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(pk)) throw new Error(`JUROR${index}_PK is malformed (expected 32-byte hex)`);
  return pk as Hex;
}

export function jurorAccount(index: number, env: Env = process.env): PrivateKeyAccount {
  return privateKeyToAccount(jurorKey(index, env));
}

/** Public juror identities (addresses only) for every configured key. */
export function jurorAddresses(env: Env = process.env): Array<{ index: number; address: Address }> {
  const out: Array<{ index: number; address: Address }> = [];
  for (const index of JUROR_INDICES) {
    if (env[`JUROR${index}_PK`]) out.push({ index, address: jurorAccount(index, env).address });
  }
  return out;
}

export function publicClientFor(cfg: ServiceConfig): Clients['publicClient'] {
  return createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl, { retryCount: 3, timeout: 30_000 }) }) as Clients['publicClient'];
}

export function jurorClients(index: number, cfg: ServiceConfig, env: Env = process.env): Clients {
  const account = jurorAccount(index, env);
  const transport = http(cfg.rpcUrl, { retryCount: 3, timeout: 30_000 });
  return {
    publicClient: createPublicClient({ chain: cfg.chain, transport }) as Clients['publicClient'],
    walletClient: createWalletClient({ account, chain: cfg.chain, transport }) as Clients['walletClient'],
    account,
    chain: cfg.chain,
  };
}

/** Deterministic hook token that serves as the one-run-per-dispute lock (< 255 bytes). */
export function lockToken(cfg: Pick<ServiceConfig, 'chainId' | 'market'>, disputeId: bigint | string): string {
  return `envmarket-jurors:${cfg.chainId}:${cfg.market.toLowerCase()}:${BigInt(disputeId).toString()}`;
}

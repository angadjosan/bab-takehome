/**
 * Configuration: repo-root .env + deployments/<chainId>.json.
 *
 * Chains: Base mainnet 8453 (primary, real USDC), Base Sepolia 84532 (kept), anvil 31337 (local tests).
 * Default CHAIN_ID is 8453.
 *
 * Precedence: process.env > .env file. Values from .env are copied into process.env when not
 * already set (dotenv semantics) so later `process.env.X` reads work.
 *
 * Deployment file (written by the contracts deploy script), accepted keys:
 *   { "chainId": 8453, "EnvMarket": "0x..", "token": "0x..", "startBlock": 123, ... }
 * Aliases: market/envMarket for EnvMarket; token/TestUSDC/testUSDC/USDC/usdc for the token.
 * Env overrides: MARKET_ADDRESS, TOKEN_ADDR / TOKEN_ADDRESS, START_BLOCK, DEPLOYMENTS_DIR, RPC_URL.
 * RPC: RPC_URL > BASE_RPC (8453) / BASE_SEPOLIA_RPC (84532) / ANVIL_RPC (31337) > public default.
 * On 8453 the token defaults to native Base USDC if no deployment/env value names it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address, type Chain, type Hex } from 'viem';
import { anvil, base, baseSepolia } from 'viem/chains';
import { privateKeyToAddress } from 'viem/accounts';

export const CHAINS: Record<number, Chain> = { [base.id]: base, [baseSepolia.id]: baseSepolia, [anvil.id]: anvil };
export const BASE_CHAIN_ID = base.id; // 8453
export const BASE_SEPOLIA_CHAIN_ID = baseSepolia.id; // 84532
export const ANVIL_CHAIN_ID = anvil.id; // 31337
export const DEFAULT_CHAIN_ID = BASE_CHAIN_ID;

/**
 * Native USDC on Base mainnet (6 decimals). Verified 2026-09-10 against Circle's published
 * address list and on-chain (`symbol()` = "USDC", `decimals()` = 6 via https://mainnet.base.org).
 */
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

export const DEFAULT_RPC: Record<number, string> = {
  [BASE_CHAIN_ID]: 'https://mainnet.base.org',
  [BASE_SEPOLIA_CHAIN_ID]: 'https://sepolia.base.org',
  [ANVIL_CHAIN_ID]: 'http://127.0.0.1:8545',
};

const RPC_ENV: Record<number, string> = {
  [BASE_CHAIN_ID]: 'BASE_RPC',
  [BASE_SEPOLIA_CHAIN_ID]: 'BASE_SEPOLIA_RPC',
  [ANVIL_CHAIN_ID]: 'ANVIL_RPC',
};

export function chainFor(chainId: number): Chain {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`unsupported chainId ${chainId} (supported: ${Object.keys(CHAINS).join(', ')})`);
  return c;
}

export const ROLES = ['deployer', 'seller', 'buyer', 'buyer2', 'runner', 'relay', 'verifier', 'juror1', 'juror2', 'juror3'] as const;
export type Role = (typeof ROLES)[number];

export interface Deployment {
  chainId: number;
  market: Address;
  token: Address;
  startBlock: bigint;
  raw: Record<string, unknown>;
}

export interface EncKeyPair {
  secretKey: Hex;
  publicKey: Hex;
}

export interface EnvConfig {
  repoRoot: string | null;
  envFile: string | null;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  deploymentFile: string | null;
  deployment: Deployment | null;
  addresses: { market: Address | null; token: Address | null };
  startBlock: bigint;
  keys: Partial<Record<Role, Hex>>;
  roleAddresses: Partial<Record<Role, Address>>;
  encKeys: { buyer?: EncKeyPair; buyer2?: EncKeyPair };
  env: Record<string, string>;
}

/** Minimal dotenv parser: KEY=VALUE, `export ` prefix, # comments, single/double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash);
      v = v.trim();
    }
    out[m[1]!] = v;
  }
  return out;
}

function walkUpFor(start: string, predicate: (dir: string) => boolean): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Locate the repo root: nearest ancestor with `.env`, else with `docs/BUILD_SPEC.md` (cwd first, then this module's location). */
export function findRepoRoot(cwd: string = process.cwd()): { root: string | null; envFile: string | null } {
  for (const start of [cwd, MODULE_DIR]) {
    const r = walkUpFor(start, (d) => isFile(path.join(d, '.env')));
    if (r) return { root: r, envFile: path.join(r, '.env') };
  }
  for (const start of [cwd, MODULE_DIR]) {
    const r = walkUpFor(start, (d) => isFile(path.join(d, 'docs', 'BUILD_SPEC.md')));
    if (r) return { root: r, envFile: null };
  }
  return { root: null, envFile: null };
}

function normPk(v: string | undefined, name: string): Hex | undefined {
  if (!v) return undefined;
  const h = (v.startsWith('0x') ? v : `0x${v}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error(`malformed ${name} in environment (expected 32-byte hex)`);
  return h as Hex;
}

function normAddr(v: unknown): Address | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return getAddress(v);
}

/** Read and normalize deployments/<chainId>.json. Returns null if absent. */
export function loadDeployment(file: string, chainId: number): Deployment | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const market = normAddr(raw.EnvMarket ?? raw.market ?? raw.envMarket);
  const token =
    normAddr(raw.token ?? raw.TestUSDC ?? raw.testUSDC ?? raw.USDC ?? raw.usdc) ?? (chainId === BASE_CHAIN_ID ? getAddress(BASE_USDC) : null);
  if (!market || !token) throw new Error(`${file}: missing EnvMarket/token address`);
  const cid = raw.chainId === undefined ? chainId : Number(raw.chainId);
  if (cid !== chainId) throw new Error(`${file}: chainId ${cid} != ${chainId}`);
  const sb = raw.startBlock ?? raw.deployBlock ?? 0;
  return { chainId, market, token, startBlock: BigInt(sb as string | number), raw };
}

export interface LoadEnvOptions {
  cwd?: string;
  /** Explicit .env path (skips discovery). */
  envFile?: string;
  /** Override CHAIN_ID. */
  chainId?: number;
  /** Throw if no market/token address is found. */
  requireDeployment?: boolean;
  /** Copy .env values into process.env when unset (default true). */
  populateProcessEnv?: boolean;
}

/** Load repo config. See module doc for precedence and file formats. */
export function loadEnv(opts: LoadEnvOptions = {}): EnvConfig {
  const found = opts.envFile ? { root: path.dirname(path.resolve(opts.envFile)), envFile: path.resolve(opts.envFile) } : findRepoRoot(opts.cwd);
  const fileVars = found.envFile && existsSync(found.envFile) ? parseDotenv(readFileSync(found.envFile, 'utf8')) : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(fileVars)) if (v !== '') env[k] = v;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== '') env[k] = v;
  if (opts.populateProcessEnv !== false) {
    for (const [k, v] of Object.entries(fileVars)) if (process.env[k] === undefined && v !== '') process.env[k] = v;
  }

  const chainId = opts.chainId ?? (env.CHAIN_ID ? Number(env.CHAIN_ID) : DEFAULT_CHAIN_ID);
  const chain = chainFor(chainId);
  const rpcEnv = RPC_ENV[chainId];
  const rpcUrl = env.RPC_URL ?? (rpcEnv ? env[rpcEnv] : undefined) ?? DEFAULT_RPC[chainId] ?? chain.rpcUrls.default.http[0]!;

  const deploymentsDir = env.DEPLOYMENTS_DIR ?? (found.root ? path.join(found.root, 'deployments') : null);
  const deploymentFile = deploymentsDir ? path.join(deploymentsDir, `${chainId}.json`) : null;
  const deployment = deploymentFile ? loadDeployment(deploymentFile, chainId) : null;
  const market = normAddr(env.MARKET_ADDRESS) ?? deployment?.market ?? null;
  const token =
    normAddr(env.TOKEN_ADDRESS ?? env.TOKEN_ADDR) ?? deployment?.token ?? (chainId === BASE_CHAIN_ID ? getAddress(BASE_USDC) : null);
  if (opts.requireDeployment && (!market || !token)) {
    throw new Error(`no deployment for chain ${chainId}: expected ${deploymentFile ?? 'deployments/<chainId>.json'} or MARKET_ADDRESS/TOKEN_ADDR`);
  }
  const startBlock = env.START_BLOCK ? BigInt(env.START_BLOCK) : deployment?.startBlock ?? 0n;

  const keys: Partial<Record<Role, Hex>> = {};
  const roleAddresses: Partial<Record<Role, Address>> = {};
  for (const role of ROLES) {
    const up = role.toUpperCase();
    const pk = normPk(env[`${up}_PK`], `${up}_PK`);
    const declared = normAddr(env[`${up}_ADDR`]);
    if (pk) {
      keys[role] = pk;
      roleAddresses[role] = privateKeyToAddress(pk);
      if (declared && declared !== roleAddresses[role]) throw new Error(`${up}_ADDR does not match ${up}_PK`);
    } else if (declared) {
      roleAddresses[role] = declared;
    }
  }
  const encKeys: EnvConfig['encKeys'] = {};
  for (const [name, prefix] of [
    ['buyer', 'BUYER_ENC'],
    ['buyer2', 'BUYER2_ENC'],
  ] as const) {
    const sk = normPk(env[`${prefix}_SK`], `${prefix}_SK`);
    const pk = normPk(env[`${prefix}_PK`], `${prefix}_PK`);
    if (sk && pk) encKeys[name] = { secretKey: sk, publicKey: pk };
  }

  return {
    repoRoot: found.root,
    envFile: found.envFile,
    chainId,
    chain,
    rpcUrl,
    deploymentFile,
    deployment,
    addresses: { market, token },
    startBlock,
    keys,
    roleAddresses,
    encKeys,
    env,
  };
}

/** Private key for a role, or a clear error. */
export function roleKey(cfg: EnvConfig, role: Role): Hex {
  const k = cfg.keys[role];
  if (!k) throw new Error(`missing ${role.toUpperCase()}_PK in environment/.env`);
  return k;
}

/** Market address or a clear error. */
export function requireMarket(cfg: EnvConfig): Address {
  if (!cfg.addresses.market) throw new Error(`EnvMarket address unknown for chain ${cfg.chainId} (deployments/${cfg.chainId}.json or MARKET_ADDRESS)`);
  return cfg.addresses.market;
}

/** Payment token address (USDC on 8453, TestUSDC on anvil) or a clear error. */
export function requireToken(cfg: EnvConfig): Address {
  if (!cfg.addresses.token) throw new Error(`token address unknown for chain ${cfg.chainId} (deployments/${cfg.chainId}.json or TOKEN_ADDR)`);
  return cfg.addresses.token;
}

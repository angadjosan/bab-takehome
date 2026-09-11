/**
 * viem clients, ABI-driven contract handles, tx waiting with explorer links.
 * All contract helpers take the ABI from src/abi/*.json at runtime (loadAbi), so contract-side
 * changes (e.g. pull-payment `withdraw()` / claimable balances) need no code change here.
 * The payment token uses viem's standard `erc20Abi` (real USDC on Base mainnet); the
 * TestUSDC ABI (mint/faucet) is only used via `testToken()` on local anvil.
 */
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getContract,
  http,
  maxUint256,
  type Abi,
  type Address,
  type Chain,
  type Hash,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadAbi } from './abi.ts';
import {
  ANVIL_CHAIN_ID,
  BASE_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  loadEnv,
  requireMarket,
  requireToken,
  roleKey,
  ROLES,
  type EnvConfig,
  type Role,
} from './config.ts';

export type EnvPublicClient = PublicClient<Transport, Chain>;
export type EnvWalletClient = WalletClient<Transport, Chain, LocalAccount>;

export interface ReadClients {
  publicClient: EnvPublicClient;
  chain: Chain;
  config: EnvConfig;
}
export interface Clients extends ReadClients {
  walletClient: EnvWalletClient;
  account: LocalAccount;
}

export interface MakeClientsOptions {
  config?: EnvConfig;
  rpcUrl?: string;
}

function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}

/**
 * Create clients. `signer` may be a private key (0x…), a role name ("seller", "relay", …) whose
 * key is read from the env, or a viem LocalAccount (e.g. the KMS mnemonic-derived account in the TEE).
 * Without a signer, returns read-only clients.
 */
export function makeClients(signer: `0x${string}` | Role | LocalAccount, opts?: MakeClientsOptions): Clients;
export function makeClients(signer?: undefined, opts?: MakeClientsOptions): ReadClients;
export function makeClients(signer?: `0x${string}` | Role | LocalAccount, opts: MakeClientsOptions = {}): Clients | ReadClients {
  const config = opts.config ?? loadEnv();
  const chain = config.chain;
  const transport = http(opts.rpcUrl ?? config.rpcUrl, { retryCount: 3, timeout: 30_000 });
  const publicClient = createPublicClient({ chain, transport }) as EnvPublicClient;
  if (signer === undefined) return { publicClient, chain, config };
  const account: LocalAccount =
    typeof signer === 'object' ? signer : isRole(signer) ? privateKeyToAccount(roleKey(config, signer)) : privateKeyToAccount(signer);
  const walletClient = createWalletClient({ account, chain, transport }) as EnvWalletClient;
  return { publicClient, walletClient, account, chain, config };
}

type ContractClient = EnvPublicClient | { public: EnvPublicClient; wallet: EnvWalletClient };
type AnyClients = ContractClient | ReadClients | Clients;

function clientArg(c: AnyClients): ContractClient {
  if ('publicClient' in c) {
    return 'walletClient' in c ? { public: c.publicClient, wallet: c.walletClient } : c.publicClient;
  }
  return c;
}

function configOf(c: AnyClients): EnvConfig {
  return 'config' in c ? c.config : loadEnv();
}

/** Loosely-typed contract handle (ABI loaded at runtime): `.read.fn([...])`, `.write.fn([...])`, `.address`, `.abi`. */
export interface LooseContract {
  address: Address;
  abi: Abi;
  read: Record<string, (args?: readonly unknown[], opts?: Record<string, unknown>) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[], opts?: Record<string, unknown>) => Promise<Hash>>;
  simulate: Record<string, (args?: readonly unknown[], opts?: Record<string, unknown>) => Promise<{ request: unknown; result: unknown }>>;
  estimateGas: Record<string, (args?: readonly unknown[], opts?: Record<string, unknown>) => Promise<bigint>>;
  getEvents: Record<string, (args?: unknown, opts?: Record<string, unknown>) => Promise<unknown[]>>;
  watchEvent: Record<string, (args: unknown, opts: Record<string, unknown>) => () => void>;
}

function contractFor(client: AnyClients, address: Address, abi: Abi): LooseContract {
  return getContract({ address, abi, client: clientArg(client) as never }) as unknown as LooseContract;
}

/** EnvMarket contract handle (read-only with a public client; read+write with Clients). */
export function market(client: AnyClients, address?: Address): LooseContract {
  return contractFor(client, address ?? requireMarket(configOf(client)), loadAbi('EnvMarket'));
}

/** Payment token (standard ERC-20 ABI: real USDC on Base, TestUSDC on anvil). */
export function token(client: AnyClients, address?: Address) {
  return getContract({ address: address ?? requireToken(configOf(client)), abi: erc20Abi, client: clientArg(client) as never });
}

/** TestUSDC handle with its full ABI (mint/faucet) — local anvil tests only. */
export function testToken(client: AnyClients, address?: Address): LooseContract {
  return contractFor(client, address ?? requireToken(configOf(client)), loadAbi('TestUSDC'));
}

const EXPLORERS: Record<number, string> = {
  [BASE_CHAIN_ID]: 'https://basescan.org',
  [BASE_SEPOLIA_CHAIN_ID]: 'https://sepolia.basescan.org',
};

/** Explorer base URL for a chain (null for local chains). */
export function explorerBase(chainId: number): string | null {
  return EXPLORERS[chainId] ?? null;
}

/** Explorer link for a tx (null for local chains). */
export function explorerTxUrl(chainId: number, hash: Hash): string | null {
  const b = explorerBase(chainId);
  return b ? `${b}/tx/${hash}` : null;
}

export function explorerAddressUrl(chainId: number, address: Address): string | null {
  const b = explorerBase(chainId);
  return b ? `${b}/address/${address}` : null;
}

export interface WaitTxOptions {
  label?: string;
  confirmations?: number;
  timeoutMs?: number;
  /** Log a line with the explorer link (default true). */
  log?: boolean | ((line: string) => void);
}

export interface WaitedTx {
  receipt: TransactionReceipt;
  url: string | null;
}

/** Wait for a receipt; throws if reverted. Logs `label: <explorer url | hash>` by default. */
export async function waitTx(publicClient: EnvPublicClient, hash: Hash, opts: WaitTxOptions = {}): Promise<WaitedTx> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: opts.confirmations ?? 1,
    timeout: opts.timeoutMs ?? 180_000,
  });
  const chainId = publicClient.chain.id;
  const url = explorerTxUrl(chainId, hash);
  const line = `${opts.label ?? 'tx'}: ${url ?? `${hash} (chain ${chainId})`} [${receipt.status}, block ${receipt.blockNumber}]`;
  if (opts.log !== false) (typeof opts.log === 'function' ? opts.log : console.log)(line);
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${line}`);
  return { receipt, url };
}

/** Simulate (for readable revert reasons), send, and wait. ABI-driven: pass any function name. */
export async function writeAndWait(
  clients: Clients,
  req: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; label?: string },
  opts: WaitTxOptions = {},
): Promise<WaitedTx & { hash: Hash; result: unknown }> {
  const { request, result } = await clients.publicClient.simulateContract({
    address: req.address,
    abi: req.abi,
    functionName: req.functionName,
    args: req.args,
    value: req.value,
    account: clients.account,
  } as never);
  const hash = await clients.walletClient.writeContract(request as never);
  const waited = await waitTx(clients.publicClient, hash, { label: req.label ?? req.functionName, ...opts });
  return { ...waited, hash, result };
}

/** writeAndWait against EnvMarket by function name (e.g. "buy", "finalize", "withdraw"). */
export async function marketWrite(
  clients: Clients,
  functionName: string,
  args: readonly unknown[] = [],
  opts: WaitTxOptions & { value?: bigint } = {},
): Promise<WaitedTx & { hash: Hash; result: unknown }> {
  return writeAndWait(
    clients,
    { address: requireMarket(clients.config), abi: loadAbi('EnvMarket'), functionName, args, value: opts.value, label: opts.label ?? functionName },
    opts,
  );
}

/** readContract against EnvMarket by function name. */
export async function marketRead<T = unknown>(client: AnyClients, functionName: string, args: readonly unknown[] = []): Promise<T> {
  const pc = 'publicClient' in client ? client.publicClient : 'public' in client ? client.public : client;
  return (await pc.readContract({ address: requireMarket(configOf(client)), abi: loadAbi('EnvMarket'), functionName, args } as never)) as T;
}

/** Approve `spender` for at least `amount` of the payment token (no-op if allowance suffices). */
export async function ensureAllowance(
  clients: Clients,
  spender: Address,
  amount: bigint,
  opts: { tokenAddress?: Address; approveMax?: boolean } = {},
): Promise<Hash | null> {
  const tokenAddress = opts.tokenAddress ?? requireToken(clients.config);
  const current = await clients.publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [clients.account.address, spender],
  });
  if (current >= amount) return null;
  const { hash } = await writeAndWait(clients, {
    address: tokenAddress,
    abi: erc20Abi as Abi,
    functionName: 'approve',
    args: [spender, opts.approveMax ? maxUint256 : amount],
    label: 'approve',
  });
  return hash;
}

export { ANVIL_CHAIN_ID, BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID };

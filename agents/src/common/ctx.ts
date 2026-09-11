/**
 * Chain context for the agents: config (repo .env + deployments/<chainId>.json via @envmarket/shared),
 * viem clients per role, typed reads of EnvMarket, and a tx sender that logs explorer links and
 * records every transaction for the demo summary.
 *
 * Safety rail: transactions are only sent on the local anvil chain (31337) unless ALLOW_LIVE_TX=1
 * is set explicitly. Nothing in this package ever auto-funds an account on a public network.
 */
import {
  erc20Abi,
  formatUnits,
  getAddress,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadAbi, loadEnv, makeClients, type Clients, type EnvConfig, type ReadClients, type Role } from '@envmarket/shared';

export const ANVIL = 31337;

const EXPLORERS: Record<number, string> = {
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
};

export function explorerTx(chainId: number, hash: Hash): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${hash}` : null;
}

export function explorerAddress(chainId: number, a: Address): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/address/${a}` : null;
}

export interface TxRecord {
  label: string;
  from: Address;
  hash: Hash;
  url: string | null;
  block: bigint;
  gasUsed: bigint;
}

/** Every tx sent by this process, in order (the demo prints it at the end). */
export const TX_LOG: TxRecord[] = [];

export interface Ctx {
  cfg: EnvConfig;
  chainId: number;
  market: Address;
  token: Address;
  read: ReadClients;
  abi: Abi;
}

let cached: Ctx | null = null;

export function loadCtx(opts: { fresh?: boolean } = {}): Ctx {
  if (cached && !opts.fresh) return cached;
  const cfg = loadEnv({ requireDeployment: true });
  const read = makeClients(undefined, { config: cfg });
  cached = {
    cfg,
    chainId: cfg.chainId,
    market: cfg.addresses.market!,
    token: cfg.addresses.token!,
    read,
    abi: loadAbi('EnvMarket'),
  };
  return cached;
}

/** Wallet clients for a role ("seller", "buyer", ...) or a raw private key. */
export function signer(ctx: Ctx, who: Role | Hex): Clients {
  return makeClients(who as never, { config: ctx.cfg }) as Clients;
}

export function addressOf(ctx: Ctx, role: Role): Address {
  const a = ctx.cfg.roleAddresses[role];
  if (!a) throw new Error(`no address for role ${role} (set ${role.toUpperCase()}_PK or _ADDR)`);
  return a;
}

export const BASE_SEPOLIA = 84532;
/** Chains the agents transact on by default: local anvil and the Base Sepolia testnet (the deployment target). */
export const DEFAULT_TX_CHAINS: readonly number[] = [ANVIL, BASE_SEPOLIA];

export function assertTxAllowed(chainId: number): void {
  if (!DEFAULT_TX_CHAINS.includes(chainId) && process.env.ALLOW_LIVE_TX !== '1') {
    throw new Error(
      `refusing to send a transaction on chain ${chainId}: agents transact only on anvil (31337) and Base Sepolia (84532) unless ALLOW_LIVE_TX=1`,
    );
  }
}

export interface SendReq {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  label?: string;
  /** Explicit nonce (for back-to-back sends from one account behind a load-balanced RPC). */
  nonce?: number;
}

export interface Sent {
  hash: Hash;
  receipt: TransactionReceipt;
  result: unknown;
  url: string | null;
}

let logFn: (line: string) => void = (l) => console.log(l);
export function setTxLogger(fn: (line: string) => void): void {
  logFn = fn;
}

/**
 * Behind a load-balanced public RPC (e.g. https://sepolia.base.org) a read issued right after a receipt
 * can land on a backend that has not imported that block yet, so post-tx checks see pre-tx state (a
 * just-created version reads as zeros; a fresh allowance reads as 0 and the next simulate reverts).
 * Wait until several consecutive calls report a head at or past the receipt's block (bounded, ~20 s).
 */
async function waitForReadsAt(pc: Clients['publicClient'], block: bigint): Promise<void> {
  let ok = 0;
  for (let i = 0; i < 20 && ok < 3; i++) {
    const head = await pc.getBlockNumber({ cacheTime: 0 }).catch(() => 0n);
    ok = head >= block ? ok + 1 : 0;
    if (ok < 3) await new Promise((r) => setTimeout(r, ok ? 300 : 1000));
  }
}

/** Simulate (readable revert reasons), send, wait, log with explorer link, record. */
export async function send(c: Clients, req: SendReq): Promise<Sent> {
  assertTxAllowed(c.chain.id);
  const { request, result } = await c.publicClient.simulateContract({
    address: req.address,
    abi: req.abi,
    functionName: req.functionName,
    args: req.args,
    account: c.account,
  } as never);
  const hash = await c.walletClient.writeContract((req.nonce === undefined ? request : { ...(request as object), nonce: req.nonce }) as never);
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  await waitForReadsAt(c.publicClient, receipt.blockNumber);
  const url = explorerTx(c.chain.id, hash);
  const label = req.label ?? req.functionName;
  const line = `  ⛓  ${label.padEnd(28)} ${url ?? hash}  [${receipt.status}, block ${receipt.blockNumber}, gas ${receipt.gasUsed}]`;
  logFn(line);
  TX_LOG.push({ label, from: c.account.address, hash, url, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${label} ${hash}`);
  return { hash, receipt, result, url };
}

export async function marketWrite(ctx: Ctx, c: Clients, functionName: string, args: readonly unknown[], label?: string): Promise<Sent> {
  return send(c, { address: ctx.market, abi: ctx.abi, functionName, args, label: label ?? functionName });
}

export async function marketRead<T = unknown>(ctx: Ctx, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await ctx.read.publicClient.readContract({ address: ctx.market, abi: ctx.abi, functionName, args } as never)) as T;
}

// ------------------------------------------------------------------ typed reads

export interface VersionTerms {
  seller: Address;
  listingId: bigint;
  versionNo: number;
  bundleHash: Hex;
  ciphertextHash: Hex;
  imageDigest: Hex;
  descriptionHash: Hex;
  manifestHash: Hex;
  licenseHash: Hex;
  taskRoot: Hex;
  auditRoot: Hex;
  taskCount: number;
  auditTaskCount: number;
  price: bigint;
  collateral: bigint;
  deliveryWindow: number;
  challengeWindow: number;
  reportHash: Hex;
  uri: string;
  active: boolean;
}

export interface PurchaseView {
  versionId: bigint;
  buyer: Address;
  seller: Address;
  state: number;
  price: bigint;
  collateral: bigint;
  buyerEncPubKey: Hex;
  fundedAt: bigint;
  deliveryDeadline: bigint;
  deliveredAt: bigint;
  challengeDeadline: bigint;
  challengeWindow: number;
  taskCount: number;
  feeBps: number;
  refundCapBps: number;
  penaltyThresholdBps: number;
  penaltyBps: number;
  bondFloor: bigint;
  bondCap: bigint;
  caseFee: bigint;
  ciphertextHash: Hex;
  wrappedKeyHash: Hex;
  wrapperHash: Hex;
  relay: Address;
  disputeId: bigint;
  remediedMask: bigint;
  refunded: bigint;
  sellerProceeds: bigint;
  fee: bigint;
  penalties: bigint;
  settledAt: bigint;
  rated: boolean;
  stars: number;
}

export interface DisputeView {
  purchaseId: bigint;
  ground: number;
  status: number;
  verdict: number;
  round: number;
  fallbackNoQuorum: boolean;
  taskMask: bigint;
  confirmedMask: bigint;
  evidenceHash: Hex;
  requested: bigint;
  bond: bigint;
  refund: bigint;
  caseFee: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
  selectionBlock: bigint;
  resolvedAt: bigint;
}

export interface SeatView {
  juror: Address;
  vote: number;
  revealed: boolean;
  commitment: Hex;
  reward: bigint;
  slashed: bigint;
}

export const getVersion = (ctx: Ctx, id: bigint) => marketRead<VersionTerms>(ctx, 'getVersion', [id]);
export const getPurchase = (ctx: Ctx, id: bigint) => marketRead<PurchaseView>(ctx, 'getPurchase', [id]);
export async function getDispute(ctx: Ctx, id: bigint): Promise<{ d: DisputeView; seats: SeatView[] }> {
  const [d, seats] = await marketRead<[DisputeView, SeatView[]]>(ctx, 'getDispute', [id]);
  return { d, seats: [...seats] };
}

export async function sellerStake(ctx: Ctx, seller: Address): Promise<{ total: bigint; reserved: bigint; available: bigint }> {
  const [total, reserved, available] = await marketRead<[bigint, bigint, bigint]>(ctx, 'sellerStake', [seller]);
  return { total, reserved, available };
}

// ------------------------------------------------------------------ token

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

let tokenInfoCache: TokenInfo | null = null;
export async function tokenInfo(ctx: Ctx): Promise<TokenInfo> {
  if (tokenInfoCache && tokenInfoCache.address === ctx.token) return tokenInfoCache;
  const pc = ctx.read.publicClient;
  const [symbol, decimals] = await Promise.all([
    pc.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'symbol' }),
    pc.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  tokenInfoCache = { address: ctx.token, symbol, decimals };
  return tokenInfoCache;
}

export async function fmt(ctx: Ctx, amount: bigint): Promise<string> {
  const t = await tokenInfo(ctx);
  return `${formatUnits(amount, t.decimals)} ${t.symbol}`;
}

export async function balanceOf(ctx: Ctx, a: Address): Promise<bigint> {
  return ctx.read.publicClient.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
}

/** Approve exactly `amount` for the market (no max approvals). Skips when allowance already equals/exceeds it. */
export async function approveExact(ctx: Ctx, c: Clients, amount: bigint, label = 'approve'): Promise<Sent | null> {
  const current = await ctx.read.publicClient.readContract({
    address: ctx.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [c.account.address, ctx.market],
  });
  if (current >= amount) return null;
  return send(c, { address: ctx.token, abi: erc20Abi as Abi, functionName: 'approve', args: [ctx.market, amount], label });
}

/** Chain time (latest block timestamp). */
export async function chainNow(ctx: Ctx): Promise<bigint> {
  const b = await ctx.read.publicClient.getBlock({ blockTag: 'latest' });
  return b.timestamp;
}

/**
 * Wait until chain time > `ts`. On anvil with FAST_FORWARD=1 this advances time with
 * evm_increaseTime + evm_mine (local test chain only); otherwise it polls in real time.
 */
export async function waitUntilChainTime(ctx: Ctx, ts: bigint, log: (s: string) => void = console.log): Promise<void> {
  const now = await chainNow(ctx);
  if (now > ts) return;
  if (ctx.chainId === ANVIL && process.env.FAST_FORWARD === '1') {
    const delta = Number(ts - now) + 1;
    log(`  ⏩ anvil: advancing chain time by ${delta}s (FAST_FORWARD=1, local test chain only)`);
    await ctx.read.publicClient.request({ method: 'evm_increaseTime' as never, params: [delta] as never });
    await ctx.read.publicClient.request({ method: 'evm_mine' as never, params: [] as never });
    return;
  }
  log(`  ⏳ waiting ${Number(ts - now) + 1}s of chain time`);
  for (;;) {
    if ((await chainNow(ctx)) > ts) return;
    await sleep(3000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function accountFromPk(pk: Hex): Address {
  return getAddress(privateKeyToAccount(pk).address);
}

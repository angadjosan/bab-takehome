/**
 * Chain access for the service: typed reads of EnvMarket views and a serialized tx sender
 * (one nonce stream for the single KMS-derived signer that holds runner/relay/verifier roles).
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { chainFor, hasAbi, loadAbi } from '@envmarket/shared';
import { errMsg, logger } from './log.ts';

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
  buyerEncPubKey: Hex;
  deliveryDeadline: bigint;
  deliveredAt: bigint;
  challengeDeadline: bigint;
  taskCount: number;
  ciphertextHash: Hex;
  wrappedKeyHash: Hex;
  wrapperHash: Hex;
  relay: Address;
  disputeId: bigint;
}

export interface DisputeView {
  purchaseId: bigint;
  ground: number;
  status: number;
  verdict: number;
  round: number;
  taskMask: bigint;
  confirmedMask: bigint;
  evidenceHash: Hex;
  findingsHash: Hex;
  verifierDeadline: bigint;
}

export interface SeatView {
  juror: Address;
  vote: number;
  revealed: boolean;
  commitment: Hex;
}

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
export { ZERO32 };

/** EnvMarket ABI: shared (packages/shared/src/abi) or, in dev before it is synced, contracts/out. */
export function marketAbi(repoRoot: string | null): Abi {
  const has = (abi: Abi, name: string) => abi.some((x) => 'name' in x && x.name === name);
  const shared = hasAbi('EnvMarket') ? loadAbi('EnvMarket') : null;
  let built: Abi | null = null;
  if (repoRoot) {
    const p = path.join(repoRoot, 'contracts', 'out', 'EnvMarket.sol', 'EnvMarket.json');
    if (existsSync(p)) built = (JSON.parse(readFileSync(p, 'utf8')) as { abi: Abi }).abi;
  }
  // dev: prefer the freshly built ABI when shared's copy predates the seller-paid preview functions
  if (built && (!shared || (!has(shared, 'requestPreview') && has(built, 'requestPreview')))) return built;
  if (shared) return shared;
  throw new Error('EnvMarket ABI not found (packages/shared/src/abi/EnvMarket.json)');
}

export function abiHas(abi: Abi, name: string): boolean {
  return abi.some((x) => 'name' in x && x.name === name);
}

export class Chain_ {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, LocalAccount>;
  readonly abi: Abi;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly chainId: number,
    rpcUrl: string,
    readonly market: Address,
    readonly account: LocalAccount,
    abi: Abi,
  ) {
    const chain = chainFor(chainId);
    const transport = http(rpcUrl, { retryCount: 3, timeout: 30_000 });
    this.publicClient = createPublicClient({ chain, transport }) as PublicClient<Transport, Chain>;
    this.walletClient = createWalletClient({ chain, transport, account }) as WalletClient<Transport, Chain, LocalAccount>;
    this.abi = abi;
  }

  async read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.publicClient.readContract({ address: this.market, abi: this.abi, functionName, args } as never)) as T;
  }

  async getVersion(versionId: bigint): Promise<VersionTerms | null> {
    const v = await this.read<VersionTerms>('getVersion', [versionId]);
    if (!v || /^0x0{40}$/i.test(v.seller)) return null;
    return { ...v, versionNo: Number(v.versionNo), taskCount: Number(v.taskCount), auditTaskCount: Number(v.auditTaskCount), deliveryWindow: Number(v.deliveryWindow), challengeWindow: Number(v.challengeWindow) };
  }

  async getPurchase(purchaseId: bigint): Promise<PurchaseView | null> {
    const p = await this.read<PurchaseView>('getPurchase', [purchaseId]);
    if (!p || Number(p.state) === 0) return null;
    return { ...p, state: Number(p.state), taskCount: Number(p.taskCount) };
  }

  async getDispute(disputeId: bigint): Promise<{ dispute: DisputeView; seats: SeatView[] } | null> {
    const [d, seats] = await this.read<[DisputeView, SeatView[]]>('getDispute', [disputeId]);
    if (!d || Number(d.ground) === 0) return null;
    return {
      dispute: { ...d, ground: Number(d.ground), status: Number(d.status), verdict: Number(d.verdict), round: Number(d.round) },
      seats: seats.map((s) => ({ ...s, vote: Number(s.vote) })),
    };
  }

  async hasRole(role: 'isRunner' | 'isRelay' | 'isVerifier'): Promise<boolean> {
    return this.read<boolean>(role, [this.account.address]);
  }

  /** Simulate, send and wait — serialized so the single signer never races its own nonce. */
  write(functionName: string, args: readonly unknown[], label = functionName): Promise<{ hash: Hash; blockNumber: bigint }> {
    const run = async () => {
      const { request } = await this.publicClient.simulateContract({
        address: this.market,
        abi: this.abi,
        functionName,
        args,
        account: this.account,
      } as never);
      const hash = await this.walletClient.writeContract(request as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`);
      logger.info('tx confirmed', { label, hash, block: receipt.blockNumber });
      return { hash, blockNumber: receipt.blockNumber };
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch((e) => logger.warn('tx failed', { label, error: errMsg(e) }));
    return p;
  }
}

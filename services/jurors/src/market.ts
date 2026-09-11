/** Thin, typed EnvMarket I/O for the juror: reads, and sends that tolerate expected reverts. */
import { loadAbi, type Clients } from '@envmarket/shared';
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Address, type Hash, type Hex } from 'viem';

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
  participationFee: bigint;
  jurorStake: bigint;
  openedAt: bigint;
  selectionBlock: bigint;
  selectionDeadline: bigint;
  commitDeadline: bigint;
  revealDeadline: bigint;
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

export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

export type SendResult = { ok: true; hash: Hash; blockNumber: bigint } | { ok: false; reason: string; sent: boolean; hash?: Hash };

/**
 * Best-effort one-line revert reason: custom error name (+args) or short message. If viem could not
 * decode the error itself, the raw selector/data is decoded against `abi` here.
 */
export function revertReason(e: unknown, abi?: Abi): string {
  const fmt = (name: string, args?: readonly unknown[]) => `${name}${args?.length ? `(${args.map(String).join(',')})` : ''}`;
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return fmt(r.data.errorName, r.data.args);
    if (r?.reason) return r.reason;
    const raw = (r?.raw ?? r?.signature ?? /0x[0-9a-fA-F]{8,}/.exec(e.message)?.[0]) as Hex | undefined;
    if (raw && abi) {
      try {
        const d = decodeErrorResult({ abi, data: raw });
        return fmt(d.errorName, d.args as readonly unknown[] | undefined);
      } catch {
        return `revert ${raw.slice(0, 10)}`;
      }
    }
    return e.shortMessage.split('\n')[0]!;
  }
  return ((e as Error)?.message ?? String(e)).split('\n')[0]!;
}

export class MarketIO {
  readonly abi: Abi;
  constructor(
    readonly clients: Clients,
    readonly address: Address,
  ) {
    this.abi = loadAbi('EnvMarket');
  }

  get me(): Address {
    return this.clients.account.address;
  }

  async read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.clients.publicClient.readContract({ address: this.address, abi: this.abi, functionName, args } as never)) as T;
  }

  async head(): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.clients.publicClient.getBlock({ blockTag: 'latest' });
    return { number: b.number, timestamp: b.timestamp };
  }

  async getDispute(id: bigint): Promise<{ d: DisputeView; seats: SeatView[] }> {
    const [d, seats] = await this.read<[DisputeView, SeatView[]]>('getDispute', [id]);
    return { d: { ...d, round: Number(d.round), ground: Number(d.ground), status: Number(d.status), verdict: Number(d.verdict) }, seats: [...seats] };
  }

  async jurorInfo(a: Address = this.me): Promise<{ approved: boolean; total: bigint; locked: bigint; free: bigint }> {
    const [approved, total, locked, free] = await this.read<[boolean, bigint, bigint, bigint]>('jurorInfo', [a]);
    return { approved, total, locked, free };
  }

  claimable(a: Address = this.me): Promise<bigint> {
    return this.read<bigint>('claimable', [a]);
  }

  /** Simulate (for a readable revert reason), send, and wait. Expected reverts are returned, not thrown. */
  async send(functionName: string, args: readonly unknown[], onSent?: (hash: Hash) => void): Promise<SendResult> {
    const { publicClient, walletClient, account } = this.clients;
    let request: unknown;
    try {
      ({ request } = await publicClient.simulateContract({ address: this.address, abi: this.abi, functionName, args, account } as never));
    } catch (e) {
      return { ok: false, reason: revertReason(e, this.abi), sent: false };
    }
    let hash: Hash;
    try {
      hash = await walletClient.writeContract(request as never);
    } catch (e) {
      return { ok: false, reason: revertReason(e, this.abi), sent: false };
    }
    onSent?.(hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success') return { ok: false, reason: 'reverted on-chain', sent: true, hash };
    return { ok: true, hash, blockNumber: receipt.blockNumber };
  }
}

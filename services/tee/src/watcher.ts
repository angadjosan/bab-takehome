/**
 * Chain watcher: polls eth_getLogs from START_BLOCK with a persisted cursor and dispatches
 * Purchased → relay, DisputeOpened (mechanical ground) → verifier. Handlers are idempotent (they
 * re-read on-chain state), so reprocessing a range after a restart is safe. Failed handlers are
 * retried on later polls (bounded), without blocking the cursor.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AbiEvent } from 'viem';
import type { Ctx } from './context.ts';
import { errMsg, logger } from './log.ts';
import { handlePurchased } from './relay.ts';
import { GROUND, handleDisputeOpened } from './verifier.ts';

interface Cursor {
  chainId: number;
  market: string;
  next: string; // next block to scan
}

type Job = { key: string; kind: 'purchase' | 'dispute'; id: bigint; attempts: number; notBefore: number };

export class Watcher {
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #retry = new Map<string, Job>();
  #file: string;
  lastPoll: string | null = null;
  lastError: string | null = null;

  constructor(private readonly ctx: Ctx) {
    const c = ctx.chain!;
    this.#file = path.join(ctx.cfg.dataDir, 'state', `cursor-${c.chainId}-${c.market.toLowerCase()}.json`);
  }

  get cursor(): bigint {
    try {
      const c = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as Cursor;
      return BigInt(c.next);
    } catch {
      return this.ctx.cfg.startBlock;
    }
  }

  #save(next: bigint): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = this.#file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ chainId: this.ctx.chain!.chainId, market: this.ctx.chain!.market, next: next.toString() } satisfies Cursor));
    fs.renameSync(tmp, this.#file);
  }

  start(): void {
    const loop = async () => {
      await this.pollOnce().catch((e) => {
        this.lastError = errMsg(e);
        logger.warn('watcher poll failed', { error: this.lastError });
      });
      this.#timer = setTimeout(loop, this.ctx.cfg.pollMs);
    };
    void loop();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #events(): AbiEvent[] {
    return (this.ctx.chain!.abi as AbiEvent[]).filter((x) => x.type === 'event' && (x.name === 'Purchased' || x.name === 'DisputeOpened'));
  }

  async pollOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const chain = this.ctx.chain!;
      const confirmations = chain.chainId === 31337 ? 0n : 2n;
      const head = (await chain.publicClient.getBlockNumber()) - confirmations;
      let from = this.cursor;
      while (from <= head) {
        const to = from + 1999n < head ? from + 1999n : head;
        const logs = await chain.publicClient.getLogs({ address: chain.market, events: this.#events(), fromBlock: from, toBlock: to });
        for (const log of logs) {
          const args = (log as unknown as { args: Record<string, unknown>; eventName: string }).args;
          const name = (log as unknown as { eventName: string }).eventName;
          if (name === 'Purchased') this.#enqueue('purchase', BigInt(args.purchaseId as bigint));
          else if (name === 'DisputeOpened') {
            const g = Number(args.ground);
            if (g === GROUND.BrokenOrHashMismatch || g === GROUND.PreviewNotReproducible) this.#enqueue('dispute', BigInt(args.disputeId as bigint));
          }
        }
        this.#save(to + 1n);
        from = to + 1n;
      }
      await this.#drain();
      this.lastPoll = new Date().toISOString();
      this.lastError = null;
    } finally {
      this.#running = false;
    }
  }

  #enqueue(kind: Job['kind'], id: bigint): void {
    const key = `${kind}:${id}`;
    if (!this.#retry.has(key)) this.#retry.set(key, { key, kind, id, attempts: 0, notBefore: 0 });
  }

  async #drain(): Promise<void> {
    const now = Date.now();
    const jobs = [...this.#retry.values()].filter((j) => j.notBefore <= now);
    // deliveries first (deadline-bound), disputes run in the background (they can take minutes)
    for (const j of jobs.filter((x) => x.kind === 'purchase')) {
      try {
        await handlePurchased(this.ctx, j.id);
        this.#retry.delete(j.key);
      } catch (e) {
        this.#fail(j, e);
      }
    }
    for (const j of jobs.filter((x) => x.kind === 'dispute')) {
      this.#retry.delete(j.key);
      handleDisputeOpened(this.ctx, j.id).catch((e) => {
        const again = { ...j };
        this.#fail(again, e);
        if (again.attempts < 8) this.#retry.set(again.key, again);
      });
    }
  }

  #fail(j: Job, e: unknown): void {
    j.attempts++;
    j.notBefore = Date.now() + Math.min(60_000, 2_000 * 2 ** j.attempts);
    logger.warn('watcher job failed', { job: j.key, attempts: j.attempts, error: errMsg(e).slice(0, 300) });
    if (j.attempts >= 8) {
      this.#retry.delete(j.key);
      logger.error('watcher job abandoned', { job: j.key });
    }
  }

  status(): Record<string, unknown> {
    return { cursor: this.cursor.toString(), lastPoll: this.lastPoll, lastError: this.lastError, pending: [...this.#retry.keys()] };
  }
}

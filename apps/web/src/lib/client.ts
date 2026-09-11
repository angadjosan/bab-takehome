import { createPublicClient, http, parseEventLogs, type Hex, type Log } from "viem";
import { chain, deployment, RPC_URL } from "./config";
import { marketAbi } from "./abi";

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { batch: { batchSize: 50, wait: 16 }, retryCount: 3 }),
});

/* ------------------------------------------------------------------------------------
 * Market event log reader.
 *
 * Reads every EnvMarket log from the deployment's startBlock in chunked block ranges
 * (Base Sepolia's public RPC caps eth_getLogs at ~10k blocks), decodes them with the ABI,
 * and caches them in memory. Subsequent calls only fetch blocks after the last one read.
 * ---------------------------------------------------------------------------------- */

export type MarketEvent = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
};

const CHUNK = 9_000n;
const CONCURRENCY = 4;

type Cache = { toBlock: bigint; events: MarketEvent[] };
let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

async function fetchRange(from: bigint, to: bigint): Promise<MarketEvent[]> {
  if (!deployment) return [];
  const ranges: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += CHUNK) {
    const e = s + CHUNK - 1n > to ? to : s + CHUNK - 1n;
    ranges.push([s, e]);
  }
  const results: Log[][] = new Array(ranges.length);
  let next = 0;
  async function worker() {
    while (next < ranges.length) {
      const i = next++;
      const [fromBlock, toBlock] = ranges[i];
      let attempt = 0;
      for (;;) {
        try {
          results[i] = await publicClient.getLogs({ address: deployment!.market, fromBlock, toBlock });
          break;
        } catch (err) {
          if (++attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker));
  const flat = results.flat();
  const decoded = parseEventLogs({ abi: marketAbi, logs: flat, strict: false });
  return decoded
    .filter((l) => "eventName" in l && l.eventName)
    .map((l) => ({
      eventName: (l as { eventName: string }).eventName,
      args: ((l as { args?: unknown }).args ?? {}) as Record<string, unknown>,
      blockNumber: l.blockNumber!,
      logIndex: l.logIndex!,
      transactionHash: l.transactionHash!,
    }));
}

export async function getMarketEvents(): Promise<MarketEvent[]> {
  if (!deployment) return [];
  if (inflight) return (await inflight).events;
  inflight = (async () => {
    const latest = await publicClient.getBlockNumber();
    const from = cache ? cache.toBlock + 1n : deployment!.startBlock;
    if (from > latest && cache) return cache;
    const fresh = await fetchRange(from, latest);
    const events = [...(cache?.events ?? []), ...fresh].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    cache = { toBlock: latest, events };
    return cache;
  })();
  try {
    return (await inflight).events;
  } finally {
    inflight = null;
  }
}

/* Block timestamps, cached. */
const blockTimes = new Map<bigint, number>();
export async function getBlockTimes(blocks: bigint[]): Promise<Map<bigint, number>> {
  const missing = [...new Set(blocks)].filter((b) => !blockTimes.has(b));
  await Promise.all(
    missing.map(async (b) => {
      try {
        const blk = await publicClient.getBlock({ blockNumber: b });
        blockTimes.set(b, Number(blk.timestamp));
      } catch {
        /* leave missing */
      }
    }),
  );
  return blockTimes;
}

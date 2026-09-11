/** Small helpers. */

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function nowIso(): string {
  return new Date().toISOString();
}

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

/** Sliding-window rate limiter (in memory). */
export class RateLimiter {
  #events = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}
  /** Record an event for `key` if under the limit; returns false (and records nothing) otherwise. */
  take(key: string, now = Date.now()): boolean {
    const arr = (this.#events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.#events.set(key, arr);
      return false;
    }
    arr.push(now);
    this.#events.set(key, arr);
    return true;
  }
  retryAfterSec(key: string, now = Date.now()): number {
    const arr = (this.#events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length < this.limit) return 0;
    return Math.ceil((this.windowMs - (now - arr[0]!)) / 1000);
  }
}

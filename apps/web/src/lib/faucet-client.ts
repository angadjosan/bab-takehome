"use client";

import { parseEther, type Address } from "viem";
import type { FaucetResponse } from "@/app/api/faucet/route";
import { publicClient } from "./client";

/** Below this the wallet can't pay for a transaction; ask the server faucet first. */
const LOW_GAS = parseEther("0.000001");

/** POST /api/faucet for `address`. Never throws; `body` is null when the server didn't answer JSON. */
export async function requestFaucet(address: Address): Promise<{ status: number; body: FaucetResponse | null }> {
  try {
    const res = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
    return { status: res.status, body: (await res.json().catch(() => null)) as FaucetResponse | null };
  } catch {
    return { status: 0, body: null };
  }
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * Called before any user-paid transaction (useTx): if the wallet has (almost) no ETH for fees, get a
 * drip from the server faucet and wait for it to land. Never throws. Returns true if funds were sent.
 */
export function ensureGas(address: Address): Promise<boolean> {
  const key = address.toLowerCase();
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      if ((await publicClient.getBalance({ address })) >= LOW_GAS) return false;
      const { body } = await requestFaucet(address);
      return !!body?.ok && body.status === "sent" && !!body.ethTx;
    } catch {
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * POST /api/faucet {address}: central test-funds faucet for Base Sepolia.
 *
 * A dedicated server wallet (FAUCET_PK, never exposed to the browser) sends the caller a small ETH
 * drip for network fees and 1,000 of the payment token (transferred from the faucet wallet's own
 * balance), so a new Privy embedded wallet with 0 ETH never hits "insufficient funds for gas".
 *
 * Limits (MVP, per server instance): one successful drip per address per 24 h and FAUCET_IP_LIMIT
 * (default 3) per IP per 24 h. On-chain checks skip the ETH drip when the wallet already holds
 * ≥ ETH_MIN and the token drip when it already holds ≥ TOKEN_MIN. Sends are serialized through one
 * in-process queue and each waits for its receipt, so the faucet wallet has one tx in flight at a time.
 *
 * With Privy gas sponsorship on (NEXT_PUBLIC_PRIVY_SPONSOR_GAS=1 and "App pays" in the dashboard),
 * embedded wallets need no ETH and the ETH drip is only a fallback for external wallets.
 */
import type { NextRequest } from "next/server";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, isAddress, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { chain, deployment, NATIVE_SYMBOL, RPC_URL } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const ETH_DRIP = parseEther(process.env.FAUCET_ETH_DRIP || "0.000005"); // ≈ 5 txs at ~0.006 gwei
const ETH_MIN = parseEther(process.env.FAUCET_ETH_MIN || "0.000003");
const TOKEN_DRIP_UNITS = 1_000;
const TOKEN_MIN_UNITS = 500;
const IP_LIMIT = Number(process.env.FAUCET_IP_LIMIT || 3);
/** ETH kept back in the faucet wallet to pay for its own sends. */
const GAS_RESERVE = parseEther("0.000002");

export type FaucetResponse =
  | { ok: true; status: "sent" | "funded"; message: string; ethTx?: Hex; tokenTx?: Hex; faucet: Address }
  | { ok: false; code: "unconfigured" | "bad_request" | "rate_limited" | "empty" | "failed"; error: string; retryAt?: number };

const byAddress = new Map<string, number>();
const byIp = new Map<string, number[]>();

/** One send sequence at a time per instance (nonce safety). */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

const rpc = process.env.FAUCET_RPC_URL || RPC_URL;
const publicClient = createPublicClient({ chain, transport: http(rpc) });

let tokenCache: { address: Address; decimals: number; symbol: string } | null = null;
async function tokenInfo() {
  if (tokenCache) return tokenCache;
  if (!deployment) throw new Error("No market deployment for this chain");
  // the app always uses the market's own token(); fall back to the deployment file's address
  let address = deployment.token;
  try {
    address = await publicClient.readContract({ address: deployment.market, abi: parseAbi(["function token() view returns (address)"]), functionName: "token" });
  } catch {}
  if (address === zeroAddress) throw new Error("No payment token configured");
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
  ]);
  tokenCache = { address, decimals, symbol };
  return tokenCache;
}

function json(body: FaucetResponse, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function clientIp(req: NextRequest) {
  return req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  const pk = process.env.FAUCET_PK;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return json({ ok: false, code: "unconfigured", error: "The faucet is not configured on this server." }, 503);

  let to: Address;
  try {
    const body = (await req.json()) as { address?: unknown };
    if (typeof body.address !== "string" || !isAddress(body.address)) throw new Error();
    to = getAddress(body.address);
  } catch {
    return json({ ok: false, code: "bad_request", error: "Send {\"address\": \"0x…\"}." }, 400);
  }
  const ip = clientIp(req);

  return serial(async () => {
    const now = Date.now();
    const last = byAddress.get(to);
    if (last && now - last < DAY_MS) return json({ ok: false, code: "rate_limited", error: "This wallet already got test funds in the last 24 hours.", retryAt: last + DAY_MS }, 429);
    const ipHits = (byIp.get(ip) ?? []).filter((t) => now - t < DAY_MS);
    if (ipHits.length >= IP_LIMIT) return json({ ok: false, code: "rate_limited", error: "Too many faucet requests from this network today. Try again tomorrow.", retryAt: ipHits[0] + DAY_MS }, 429);

    try {
      const account = privateKeyToAccount(pk as Hex, { nonceManager });
      const wallet = createWalletClient({ account, chain, transport: http(rpc) });
      const token = await tokenInfo();
      const unit = 10n ** BigInt(token.decimals);
      const tokenDrip = BigInt(TOKEN_DRIP_UNITS) * unit;
      const [userEth, userTok, faucetEth, faucetTok] = await Promise.all([
        publicClient.getBalance({ address: to }),
        publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [to] }),
        publicClient.getBalance({ address: account.address }),
        publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      ]);
      const needEth = userEth < ETH_MIN;
      const needTok = userTok < BigInt(TOKEN_MIN_UNITS) * unit;
      const amount = `${Number(formatUnits(tokenDrip, token.decimals)).toLocaleString("en-US")} ${token.symbol}`;

      if (!needEth && !needTok) return json({ ok: true, status: "funded", message: `This wallet already has ${token.symbol} and test ${NATIVE_SYMBOL} for fees.`, faucet: account.address });

      const canEth = faucetEth >= ETH_DRIP + GAS_RESERVE;
      const canTok = faucetTok >= tokenDrip && faucetEth >= GAS_RESERVE;
      if ((needEth && !canEth) || (needTok && !canTok)) {
        console.error(`[faucet] low balance: ${account.address} eth=${faucetEth} token=${faucetTok}`);
        return json({ ok: false, code: "empty", error: "The faucet is running low. Please try again later." }, 503);
      }

      // reserve the slot before sending so a queued duplicate request is rejected
      byAddress.set(to, now);
      byIp.set(ip, [...ipHits, now]);

      let ethTx: Hex | undefined;
      let tokenTx: Hex | undefined;
      try {
        if (needEth) {
          ethTx = await wallet.sendTransaction({ to, value: ETH_DRIP });
          const r = await publicClient.waitForTransactionReceipt({ hash: ethTx, timeout: 25_000 });
          if (r.status !== "success") throw new Error("ETH transfer reverted");
        }
        if (needTok) {
          tokenTx = await wallet.writeContract({ address: token.address, abi: erc20Abi, functionName: "transfer", args: [to, tokenDrip] });
          const r = await publicClient.waitForTransactionReceipt({ hash: tokenTx, timeout: 25_000 });
          if (r.status !== "success") throw new Error("Token transfer reverted");
        }
      } catch (e) {
        if (!ethTx && !tokenTx) {
          // nothing went out: release the reservation
          byAddress.delete(to);
          byIp.set(ip, ipHits);
        }
        throw e;
      }

      const message =
        needEth && needTok
          ? `Sent ${amount} and a little test ${NATIVE_SYMBOL} for fees.`
          : needTok
            ? `Sent ${amount}. You already had test ${NATIVE_SYMBOL} for fees.`
            : `Sent a little test ${NATIVE_SYMBOL} for fees. You already have ${token.symbol}.`;
      return json({ ok: true, status: "sent", message, ethTx, tokenTx, faucet: account.address });
    } catch (e) {
      console.error("[faucet] send failed", e);
      return json({ ok: false, code: "failed", error: "The faucet could not send funds right now. Please try again in a minute." }, 502);
    }
  });
}

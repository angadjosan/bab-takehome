import { formatUnits } from "viem";
import { tokenMeta } from "./token";

/** Format a payment-token amount using the decimals/symbol read from the token contract. */
export function fmtUsdc(v: bigint | undefined | null, opts: { symbol?: boolean; decimals?: number } = {}) {
  if (v === undefined || v === null) return "—";
  const TOKEN_DECIMALS = tokenMeta.decimals;
  const TOKEN_SYMBOL = tokenMeta.symbol;
  const s = formatUnits(v, TOKEN_DECIMALS);
  const [i, f = ""] = s.split(".");
  const d = opts.decimals ?? 2;
  const trimmed = f.replace(/0+$/, "");
  const frac = trimmed.length > d ? trimmed : trimmed.padEnd(d, "0");
  const int = BigInt(i.replace("-", "")).toLocaleString("en-US");
  const out = `${i.startsWith("-") ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
  return opts.symbol === false ? out : `${out} ${TOKEN_SYMBOL}`;
}

export function shortAddr(a?: string | null) {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortHash(h?: string | null, n = 8) {
  if (!h) return "—";
  return `${h.slice(0, 2 + n)}…${h.slice(-4)}`;
}

export function fmtDuration(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

export function fmtWindow(sec: number | bigint) {
  const s = Number(sec);
  if (s % 86400 === 0 && s >= 86400) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0 && s >= 60) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return `${s} seconds`;
}

export function fmtTime(unix?: number | bigint | null) {
  if (!unix) return "—";
  const d = new Date(Number(unix) * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtAgo(unix?: number | bigint | null, now = Date.now() / 1000) {
  if (!unix) return "";
  const diff = now - Number(unix);
  if (diff < 0) return `in ${fmtDuration(-diff)}`;
  if (diff < 45) return "just now";
  return `${fmtDuration(diff).split(" ")[0]} ago`;
}

export function pct(bps: number | bigint) {
  return `${Number(bps) / 100}%`;
}

/** Locale-aware fixed-decimal number (Intl), e.g. ratings, shares, ETH balances. */
export function fmtDec(n: number, digits: number) {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Byte count as KiB with a non-breaking space: "12.4 KiB". */
export function fmtKiB(bytes: number) {
  return `${fmtDec(bytes / 1024, 1)} KiB`;
}

export function popcount(mask: bigint) {
  let n = 0;
  let m = mask;
  while (m > 0n) {
    n += Number(m & 1n);
    m >>= 1n;
  }
  return n;
}

export function maskToIndexes(mask: bigint): number[] {
  const out: number[] = [];
  let m = mask;
  let i = 0;
  while (m > 0n) {
    if (m & 1n) out.push(i);
    m >>= 1n;
    i++;
  }
  return out;
}

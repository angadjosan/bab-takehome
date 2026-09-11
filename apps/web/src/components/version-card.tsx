"use client";

import Link from "next/link";
import { QUALIFY_THRESHOLD, useSellerScore, useSellerStake, type VersionStats } from "@/lib/market";
import { fmtDec, fmtUsdc, shortAddr } from "@/lib/format";
import { Chip, Stars, cx } from "./ui";

export function EnvRating({ stats, className }: { stats?: VersionStats; className?: string }) {
  if (!stats) return <div className={cx("text-muted", className)}>Rating …</div>;
  if (stats.ratingCount === 0) return <div className={cx("text-muted", className)}>No buyer ratings yet</div>;
  const avg = stats.ratingSum / stats.ratingCount;
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5", className)}>
      <Stars value={avg} size="text-sm" />
      <span className="font-mono font-medium tabular-nums">{fmtDec(avg, 1)}</span>
      <span className="text-muted">
        from {stats.ratingCount} buyer{stats.ratingCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** Seller standing in one line: new/eligible, sales count, stake. The address links to the account page. */
export function SellerLine({ seller }: { seller: `0x${string}` }) {
  const stake = useSellerStake(seller);
  const score = useSellerScore(seller);
  const n = score.data?.qualifyingTx;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
      <span>Sold by</span>
      <Link href={`/seller/${seller}`} className="link font-mono" translate="no" title={seller}>
        {shortAddr(seller)}
      </Link>
      {!score.data ? (
        <span>…</span>
      ) : score.data.eligible ? (
        <Chip tone="ok">{n?.toString()} completed sales</Chip>
      ) : (
        <Chip tone="neutral">
          New seller · {n?.toString()}/{QUALIFY_THRESHOLD.toString()} sales
        </Chip>
      )}
      {stake.data && (
        <span>
          · <span className="font-mono text-ink tabular-nums">{fmtUsdc(stake.data.total)}</span> staked
        </span>
      )}
    </div>
  );
}

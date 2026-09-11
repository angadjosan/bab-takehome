"use client";

import Link from "next/link";
import { describe, useDoc } from "@/lib/docs";
import { QUALIFY_THRESHOLD, isZeroHash, useSellerScore, useSellerStake, useVersionStats, type Version, type VersionStats } from "@/lib/market";
import { fmtUsdc, fmtWindow, shortAddr } from "@/lib/format";
import { useTokenInfo } from "./providers";
import { Chip, IconShield, Skeleton, Stars, cx } from "./ui";

/**
 * One environment on the browse list: what you get and what it costs, as a single link.
 * Verification detail lives on the listing page; the row only flags problems.
 */
export function VersionRow({ v }: { v: Version }) {
  const doc = useDoc(v.uri, v.descriptionHash);
  const stats = useVersionStats(v.id);
  const token = useTokenInfo();
  const d = describe(doc.data?.json);
  const noReport = isZeroHash(v.reportHash);
  const descBad = !!doc.error || doc.data?.ok === false;
  const title = d.title ?? `Environment #${v.id}`;
  const rating = stats.data && stats.data.ratingCount > 0 ? stats.data.ratingSum / stats.data.ratingCount : null;
  return (
    <li>
      <Link href={`/listing/${v.id}`} className="group flex flex-col gap-3 px-4 py-4 transition-colors duration-150 hover:bg-panel-2 sm:flex-row sm:items-start sm:gap-8 sm:px-5 sm:py-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-[15px] leading-snug font-medium text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-[3px]">
            {doc.isLoading ? <Skeleton className="h-5 w-64" /> : title}
          </h3>
          {d.summary && <p className="line-clamp-2 max-w-[70ch] text-[13px] leading-relaxed text-muted">{d.summary}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1 text-xs text-muted">
            <span>
              <span className="font-mono text-ink tabular-nums">{v.taskCount}</span> tasks
            </span>
            {d.environmentType && <span>{d.environmentType}</span>}
            <span>{fmtWindow(v.challengeWindow)} to report problems</span>
            {rating !== null && (
              <span className="inline-flex items-center gap-1">
                <Stars value={rating} size="text-xs" />
                <span className="font-mono tabular-nums">{rating.toFixed(1)}</span>
              </span>
            )}
            {d.skills.slice(0, 3).map((s) => (
              <span key={s} className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
                {s}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-start sm:gap-2">
          <div className="font-mono text-base font-medium text-ink tabular-nums">
            {fmtUsdc(v.price, { symbol: false })} <span className="text-xs font-normal text-muted" translate="no">{token.symbol}</span>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {!v.active ? (
              <Chip tone="warn">Not for sale</Chip>
            ) : noReport ? (
              <Chip tone="warn">Preview pending</Chip>
            ) : descBad ? (
              <Chip tone="bad" title="The description served doesn’t match what the seller committed on-chain">
                Description changed
              </Chip>
            ) : (
              <Chip tone="ok" title="A TEE-signed preview report is attached and the description matches the seller’s on-chain commitment">
                <IconShield className="h-3 w-3" /> Verified preview
              </Chip>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

export function ListingRowSkeleton() {
  return (
    <li className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:gap-8 sm:px-5">
      <div className="flex-1 space-y-2.5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3 w-48" />
      </div>
      <div className="space-y-2 sm:w-32">
        <Skeleton className="ml-auto h-5 w-24" />
        <Skeleton className="ml-auto h-5 w-28" />
      </div>
    </li>
  );
}

export function EnvRating({ stats, className }: { stats?: VersionStats; className?: string }) {
  if (!stats) return <div className={cx("text-muted", className)}>Rating …</div>;
  if (stats.ratingCount === 0) return <div className={cx("text-muted", className)}>No buyer ratings yet</div>;
  const avg = stats.ratingSum / stats.ratingCount;
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5", className)}>
      <Stars value={avg} size="text-sm" />
      <span className="font-mono font-medium tabular-nums">{avg.toFixed(1)}</span>
      <span className="text-muted">
        from {stats.ratingCount} buyer{stats.ratingCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** Seller standing in one line: new/eligible, sales count, stake. The address links to the account page. */
export function SellerLine({ seller, link = false }: { seller: `0x${string}`; link?: boolean }) {
  const stake = useSellerStake(seller);
  const score = useSellerScore(seller);
  const n = score.data?.qualifyingTx;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
      <span>Sold by</span>
      {link ? (
        <Link href={`/seller/${seller}`} className="link font-mono" translate="no" title={seller}>
          {shortAddr(seller)}
        </Link>
      ) : (
        <span className="font-mono text-ink" translate="no" title={seller}>
          {shortAddr(seller)}
        </span>
      )}
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

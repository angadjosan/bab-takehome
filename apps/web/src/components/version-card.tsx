"use client";

import Link from "next/link";
import { describe, useDoc } from "@/lib/docs";
import { QUALIFY_THRESHOLD, isZeroHash, useSellerScore, useSellerStake, useVersionStats, type Version, type VersionStats } from "@/lib/market";
import { fmtUsdc, fmtWindow, shortAddr } from "@/lib/format";
import { useTokenInfo } from "./providers";
import { Skeleton, Stars, Verified, cx } from "./ui";

export function VersionCard({ v }: { v: Version }) {
  const doc = useDoc(v.uri, v.descriptionHash);
  const stats = useVersionStats(v.id);
  const token = useTokenInfo();
  const d = describe(doc.data?.json);
  const noReport = isZeroHash(v.reportHash);
  return (
    <Link href={`/listing/${v.id}`} className="card group flex flex-col p-5 transition hover:border-line-strong hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>
              Listing #{v.listingId.toString()} · v{v.versionNo}
            </span>
            {d.environmentType && <span className="badge badge-neutral">{d.environmentType}</span>}
            {!v.active && <span className="badge badge-warn">inactive</span>}
          </div>
          <h3 className="mt-1.5 text-base font-semibold leading-snug group-hover:text-accent">
            {doc.isLoading ? <Skeleton className="h-5 w-48" /> : d.title ?? `Environment version #${v.id}`}
          </h3>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">{fmtUsdc(v.price, { symbol: false })}</div>
          <div className="text-[11px] text-muted">{token.symbol}</div>
        </div>
      </div>

      {d.summary && <p className="mt-2 line-clamp-2 text-sm text-muted">{d.summary}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Verified
          ok={doc.error ? false : doc.data?.ok}
          pending={doc.isLoading}
          okText="description sha256 ✓"
          badText={doc.error ? "description unavailable" : "description sha256 ✗"}
          title="sha256 of description.json recomputed in your browser and compared with the on-chain descriptionHash"
        />
        {noReport ? <span className="badge badge-warn">no signed preview yet</span> : <span className="badge badge-accent">signed TEE preview</span>}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 text-sm">
        <div>
          <div className="section-title">Tasks</div>
          <div className="mt-0.5 font-medium tabular-nums">{v.taskCount}</div>
          <div className="text-[11px] text-muted">+{v.auditTaskCount} audit (not sold)</div>
        </div>
        <div>
          <div className="section-title">Challenge</div>
          <div className="mt-0.5 font-medium">{fmtWindow(v.challengeWindow)}</div>
          <div className="text-[11px] text-muted">after key delivery</div>
        </div>
        <div>
          <div className="section-title">Disputes</div>
          <div className="mt-0.5 font-medium tabular-nums">{stats.data ? stats.data.disputesOpened : "…"}</div>
          <div className="text-[11px] text-muted">{stats.data ? `${stats.data.disputesUpheld} upheld · ${stats.data.settledCount} settled` : ""}</div>
        </div>
      </div>

      {d.skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {d.skills.slice(0, 6).map((s) => (
            <span key={s} className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
              {s}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs">
        <EnvRating stats={stats.data} />
        <SellerLine seller={v.seller} />
      </div>
    </Link>
  );
}

export function EnvRating({ stats, className }: { stats?: VersionStats; className?: string }) {
  if (!stats) return <div className={cx("text-muted", className)}>Environment rating: …</div>;
  if (stats.ratingCount === 0) return <div className={cx("text-muted", className)}>Environment rating: No purchaser ratings yet</div>;
  const avg = stats.ratingSum / stats.ratingCount;
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-muted">Environment rating:</span>
      <Stars value={avg} size="text-sm" />
      <span className="font-medium">{avg.toFixed(1)}</span>
      <span className="text-muted">
        ({stats.ratingCount} purchaser rating{stats.ratingCount === 1 ? "" : "s"})
      </span>
    </div>
  );
}

/** "New seller — N/100 transactions · Seller stake: X (reserved Y, available Z)" */
export function SellerLine({ seller, link = false }: { seller: `0x${string}`; link?: boolean }) {
  const stake = useSellerStake(seller);
  const score = useSellerScore(seller);
  const n = score.data?.qualifyingTx;
  return (
    <div className="text-muted">
      {link ? (
        <Link href={`/seller/${seller}`} className="link font-mono">
          {shortAddr(seller)}
        </Link>
      ) : (
        <span className="font-mono">{shortAddr(seller)}</span>
      )}
      {" · "}
      {!score.data ? (
        "…"
      ) : score.data.eligible ? (
        <span className="text-ok">Eligible seller — {n?.toString()} qualifying transactions</span>
      ) : (
        <span className="text-warn">
          New seller — {n?.toString()}/{QUALIFY_THRESHOLD.toString()} transactions
        </span>
      )}
      {stake.data && (
        <>
          {" · "}Seller stake: {fmtUsdc(stake.data.total)} (reserved {fmtUsdc(stake.data.reserved, { symbol: false })}, available {fmtUsdc(stake.data.available, { symbol: false })})
        </>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, type ReactNode } from "react";
import { describe, fmtPass, modelRuns, useDoc, useVerifiedReport } from "@/lib/docs";
import { isZeroHash, useSellerScore, useSellerStake, useVersionStats, type Version } from "@/lib/market";
import type { ModelResult } from "@/lib/tee";
import { fmtDec, fmtUsdc, fmtWindow, shortAddr } from "@/lib/format";
import { useTokenInfo } from "./providers";
import { Chip, IconShield, Skeleton, Stars, cx, type Tone } from "./ui";

/** What the browser filters and sorts on, reported up by each card from the same queries it renders. */
export type EnvFacts = {
  title?: string;
  summary?: string;
  environmentType?: string;
  environmentVersion?: string;
  skills: string[];
  status: string;
  rating: number | null;
  sold: number;
  topPass: number | null;
};

const MAX_OTHER_MODELS = 3;

function isoDate(d?: string) {
  if (!d) return undefined;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? undefined : t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Models with valid (non-infra) runs first, highest purchased-task pass@1 first. */
function rankModels(models: ModelResult[]) {
  return [...models].sort((a, b) => {
    const ra = modelRuns(a).ran ? 1 : 0;
    const rb = modelRuns(b).ran ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.purchased.pass1Rounded ?? -1) - (a.purchased.pass1Rounded ?? -1);
  });
}

const infraText = (r: { infra: number; total: number }) => `${r.infra}/${r.total} infra failures`;

type Status = { label: string; tone: Tone; title?: string };

export function EnvCard({ v, hidden, onFacts }: { v: Version; hidden?: boolean; onFacts: (id: string, f: EnvFacts) => void }) {
  const doc = useDoc(v.uri, v.descriptionHash);
  const stats = useVersionStats(v.id);
  const report = useVerifiedReport(v);
  const score = useSellerScore(v.seller);
  const stake = useSellerStake(v.seller);
  const token = useTokenInfo();

  const d = useMemo(() => describe(doc.data?.json), [doc.data]);
  const r = report.data?.report;
  const models = useMemo(() => (r ? rankModels(r.models) : []), [r]);
  const best = models[0] && modelRuns(models[0]).ran && models[0].purchased.pass1Rounded !== null ? models[0] : undefined;
  const bestRuns = best ? modelRuns(best) : undefined;
  const topPass = best ? best.purchased.pass1Rounded : null;
  const allRuns = models.map(modelRuns).reduce((s, x) => ({ infra: s.infra + x.infra, total: s.total + x.total }), { infra: 0, total: 0 });

  const noReport = isZeroHash(v.reportHash);
  const descBad = !!doc.error || doc.data?.ok === false;
  const rv = report.data;
  const reportBad = !!rv && (!rv.hashMatchesChain || !rv.bundleMatches || !rv.versionMatches || rv.signatureValid === false);
  const status: Status = !v.active
    ? { label: "Not for sale", tone: "warn" }
    : noReport
      ? { label: "Preview pending", tone: "warn" }
      : descBad
        ? { label: "Description hash mismatch", tone: "bad", title: "The description served doesn’t hash to the seller’s on-chain descriptionHash" }
        : reportBad
          ? { label: "Report mismatch", tone: "bad", title: "The preview report’s hash, bundle, version or signature doesn’t match the chain" }
          : report.error
            ? { label: "Report unavailable", tone: "warn" }
            : rv
              ? { label: "Verified preview", tone: "ok", title: ["sha256 = on-chain reportHash", "bundleHash matches", rv.signatureValid ? "EIP-712 signature valid" : null].filter(Boolean).join(" · ") }
              : { label: "Checking preview", tone: "neutral" };

  const s = stats.data;
  const rating = s && s.ratingCount > 0 ? s.ratingSum / s.ratingCount : null;

  const facts = useMemo<EnvFacts>(
    () => ({
      title: d.title,
      summary: d.summary,
      environmentType: d.environmentType,
      environmentVersion: d.environmentVersion,
      skills: d.skills,
      status: status.label,
      rating,
      sold: s?.settledCount ?? 0,
      topPass,
    }),
    [d, status.label, rating, s?.settledCount, topPass],
  );
  const id = v.id.toString();
  useEffect(() => onFacts(id, facts), [id, facts, onFacts]);

  const perTask = v.taskCount > 0 ? v.price / BigInt(v.taskCount) : null;
  const previewed = isoDate(r?.createdAt);
  const others = best ? models.slice(1) : models;

  return (
    <li hidden={hidden} className="group relative flex min-w-0 flex-col rounded-lg border border-line bg-panel transition-colors duration-150 hover:border-line-strong hover:bg-panel-2">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {d.environmentType && <span className="font-medium text-ink/80">{d.environmentType}</span>}
            {d.skills.slice(0, 2).map((k) => (
              <span key={k} className="truncate">
                · {k}
              </span>
            ))}
            {d.skills.length > 2 && <span>+{d.skills.length - 2}</span>}
          </span>
          {status.tone === "ok" ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-ok" title={status.title}>
              <IconShield className="h-3 w-3" /> {status.label}
            </span>
          ) : (
            <Chip tone={status.tone} title={status.title} className="shrink-0">
              {status.label}
            </Chip>
          )}
        </div>

        <h3 className="line-clamp-2 text-[15px] leading-snug font-medium text-ink" title={d.summary}>
          {doc.isLoading ? (
            <Skeleton className="h-5 w-4/5" />
          ) : (
            <Link href={`/listing/${id}`} className="after:absolute after:inset-0 after:rounded-lg after:content-[''] group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-[3px]">
              {d.title ?? `Version #${id}`}
            </Link>
          )}
        </h3>

        {noReport ? (
          <div className="font-mono text-2xl font-medium text-muted">Preview pending</div>
        ) : report.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ) : (
          <div className="space-y-2.5">
            {best && bestRuns ? (
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-muted" title={best.resolved ?? best.requested} translate="no">
                    {best.requested}
                  </div>
                  <div className="text-[11px] text-muted">
                    pass@1 · n={best.purchased.attempted}
                    {v.auditTaskCount > 0 && best.audit.attempted > 0 && <> · audit {fmtPass(best.audit.pass1Rounded)}</>}
                  </div>
                  {bestRuns.infra > 0 && <div className={cx("text-[11px]", bestRuns.infraMostly ? "text-warn" : "text-muted")}>{infraText(bestRuns)}</div>}
                </div>
                <div className={cx("shrink-0 font-mono leading-none font-semibold tabular-nums", bestRuns.infraMostly ? "text-2xl text-faint" : "text-4xl text-ink")}>{fmtPass(best.purchased.pass1Rounded)}</div>
              </div>
            ) : models.length > 0 && allRuns.infra > 0 ? (
              <div>
                <div className="font-mono text-2xl font-medium text-warn">No valid runs</div>
                <div className="text-[11px] text-muted">{infraText(allRuns)}</div>
              </div>
            ) : (
              <div className="font-mono text-2xl font-medium text-faint">—</div>
            )}
            {others.length > 0 && (
              <ul className="space-y-1 border-t border-line pt-2">
                {others.slice(0, MAX_OTHER_MODELS).map((m) => (
                  <ModelRow key={m.requested} m={m} />
                ))}
                {others.length > MAX_OTHER_MODELS && <li className="text-[11px] text-muted">+{others.length - MAX_OTHER_MODELS} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="space-y-1.5 border-t border-line px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-mono text-base font-semibold text-ink tabular-nums">
            {fmtUsdc(v.price, { symbol: false })}{" "}
            <span className="text-[11px] font-normal text-muted" translate="no">
              {token.symbol}
            </span>
          </span>
          <Stat>
            <b>{v.taskCount}</b> tasks
          </Stat>
          <Stat>
            <b>{fmtWindow(v.challengeWindow)}</b> protection
          </Stat>
          <Stat>
            <b>{s ? s.settledCount : "…"}</b> sold
          </Stat>
          {rating !== null && (
            <span className="inline-flex items-center gap-1">
              <Stars value={rating} size="text-[11px]" />
              <b className="font-mono font-normal text-ink tabular-nums">{fmtDec(rating, 1)}</b>
              <span className="font-mono tabular-nums">({s!.ratingCount})</span>
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted tabular-nums">
          {perTask !== null && <span>{fmtUsdc(perTask, { symbol: false })}/task</span>}
          {v.auditTaskCount > 0 && <span>· {v.auditTaskCount} audit tasks</span>}
          <span>· delivery {fmtWindow(v.deliveryWindow)}</span>
          <span>· collateral {fmtUsdc(v.collateral, { symbol: false })}</span>
          {s && (
            <span>
              · {s.disputesOpened} disputes{s.disputesOpened > 0 && ` (${s.disputesUpheld} upheld)`}
            </span>
          )}
          {s && s.retainedVolume > 0n && <span>· {fmtUsdc(s.retainedVolume, { symbol: false })} retained</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted tabular-nums" translate="no">
          <Link href={`/seller/${v.seller}`} className="link relative z-10" title={v.seller}>
            {shortAddr(v.seller)}
          </Link>
          {score.data && <span>· {score.data.qualifyingTx.toString()} seller sales</span>}
          {stake.data && <span>· {fmtUsdc(stake.data.total, { symbol: false })} staked</span>}
          <span>
            · #{id} · listing {v.listingId.toString()} · v{v.versionNo}
          </span>
          {d.environmentVersion && <span>· {d.environmentVersion}</span>}
          {previewed && <span>· preview {previewed}</span>}
        </div>
      </div>
    </li>
  );
}

function Stat({ children }: { children: ReactNode }) {
  return <span className="[&>b]:font-mono [&>b]:font-normal [&>b]:text-ink [&>b]:tabular-nums">{children}</span>;
}

function ModelRow({ m }: { m: ModelResult }) {
  const runs = modelRuns(m);
  const pct = Math.min(100, m.purchased.pass1Rounded ?? 0);
  const noValid = m.status === "run" && !runs.ran;
  const label = runs.ran ? `${fmtPass(m.purchased.pass1Rounded)} solved` : noValid ? `no valid runs, ${infraText(runs)}` : m.status;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_3.5rem_auto] items-center gap-x-2 text-xs" title={runs.infra > 0 ? infraText(runs) : undefined}>
      <span className="truncate font-mono text-[11px] text-ink/85" title={m.resolved ?? m.requested} translate="no">
        {m.requested}
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-panel-2 group-hover:bg-bg" role="img" aria-label={label}>
        {runs.ran && <span className={cx("block h-full rounded-full", runs.infraMostly ? "bg-faint" : "bg-accent")} style={{ width: `${pct}%` }} />}
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums">
        {runs.ran ? (
          <span className={runs.infraMostly ? "text-faint" : "text-ink"}>{fmtPass(m.purchased.pass1Rounded)}</span>
        ) : noValid ? (
          <span className="text-warn">{runs.infra}/{runs.total} infra</span>
        ) : (
          <span className="text-faint">{m.status}</span>
        )}
      </span>
    </li>
  );
}

export function EnvCardSkeleton() {
  return (
    <li aria-hidden className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-5 w-4/5" />
      <div className="flex justify-between gap-3">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-9 w-16" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="mt-1 h-5 w-3/4" />
    </li>
  );
}

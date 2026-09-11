"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { describe, fmtPass, modelRuns, useDoc, useVerifiedReport } from "@/lib/docs";
import { isZeroHash, useSellerScore, useVersionStats, type Version } from "@/lib/market";
import { modelName, panelAverage, REFERENCE_MODELS_NOTE } from "@/lib/models";
import type { ModelResult } from "@/lib/tee";
import { fmtDec, fmtUsdc, fmtWindow } from "@/lib/format";
import { useTokenInfo } from "./providers";
import { Chip, IconShield, Skeleton, cx, type Tone } from "./ui";

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
  /** Reference-panel average (purchased-task pass@1). */
  topPass: number | null;
};

const infraText = (r: { infra: number; total: number }) => `${r.infra}/${r.total} infra failures`;

type Status = { label: string; tone: Tone; title?: string };

/**
 * Browse card in three blocks: what it is (title, one line), how the reference models did (one
 * headline number plus a row per model), and what it costs (price, tasks, protection window, one
 * seller chip). Everything else lives on the listing page. The whole card is the link.
 */
export function EnvCard({ v, hidden, onFacts }: { v: Version; hidden?: boolean; onFacts: (id: string, f: EnvFacts) => void }) {
  const doc = useDoc(v.uri, v.descriptionHash);
  const stats = useVersionStats(v.id);
  const report = useVerifiedReport(v);
  const token = useTokenInfo();

  const d = useMemo(() => describe(doc.data?.json), [doc.data]);
  const r = report.data?.report;
  const models = useMemo(() => r?.models ?? [], [r]);
  const panel = useMemo(() => panelAverage(models), [models]);
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
      topPass: panel.avg,
    }),
    [d, status.label, rating, s?.settledCount, panel.avg],
  );
  const id = v.id.toString();
  useEffect(() => onFacts(id, facts), [id, facts, onFacts]);

  return (
    <li hidden={hidden} className="group relative flex min-w-0 flex-col rounded-lg border border-line bg-panel transition-colors duration-150 hover:border-line-strong">
      {/* what it is */}
      <div className="space-y-1.5 p-4">
        <h3 className="line-clamp-2 text-[15px] leading-snug font-medium text-ink">
          {doc.isLoading ? (
            <Skeleton className="h-5 w-4/5" />
          ) : (
            <Link
              href={`/listing/${id}`}
              className="after:absolute after:inset-0 after:rounded-lg after:content-[''] group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-[3px]"
            >
              {d.title ?? `Environment #${id}`}
            </Link>
          )}
        </h3>
        {doc.isLoading ? <Skeleton className="h-4 w-full" /> : d.summary && <p className="line-clamp-1 text-[13px] text-muted" title={d.summary}>{d.summary}</p>}
      </div>

      {/* how the reference models did */}
      <div className="flex-1 space-y-3 border-t border-line bg-panel-2/50 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span title={REFERENCE_MODELS_NOTE}>Reference models solved</span>
          {status.tone === "ok" ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-ok" title={status.title}>
              <IconShield className="h-3 w-3" /> Verified
            </span>
          ) : (
            <Chip tone={status.tone} title={status.title} className="shrink-0">
              {status.label}
            </Chip>
          )}
        </div>
        {noReport ? (
          <p className="text-[13px] text-muted">Scores appear once the preview run finishes.</p>
        ) : report.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ) : panel.avg !== null ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-3xl leading-none font-semibold text-ink tabular-nums">{fmtPass(panel.avg)}</span>
              <span className="text-xs text-muted">
                · {panel.ran} model{panel.ran === 1 ? "" : "s"}
                {panel.ran < panel.total && ` of ${panel.total}`}
              </span>
            </div>
            <ul className="space-y-1">
              {models.map((m) => (
                <ModelRow key={m.requested} m={m} />
              ))}
            </ul>
          </>
        ) : models.length > 0 && allRuns.infra > 0 ? (
          <div>
            <div className="font-mono text-xl font-medium text-warn">No valid runs</div>
            <div className="text-[11px] text-muted">{infraText(allRuns)}</div>
          </div>
        ) : (
          <div className="font-mono text-xl font-medium text-faint">—</div>
        )}
      </div>

      {/* what it costs */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-t border-line px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-lg leading-tight font-semibold text-ink tabular-nums">
            {fmtUsdc(v.price, { symbol: false })}{" "}
            <span className="text-[11px] font-normal text-muted" translate="no">
              {token.symbol}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            <span className="font-mono text-ink/85 tabular-nums">{v.taskCount}</span> tasks · <span className="font-mono text-ink/85 tabular-nums">{fmtWindow(v.challengeWindow)}</span> protection
          </div>
        </div>
        <SellerChip seller={v.seller} />
      </div>
    </li>
  );
}

/** One chip for seller standing: "New seller" until the contract's sales threshold, then the weighted rating. */
function SellerChip({ seller }: { seller: `0x${string}` }) {
  const score = useSellerScore(seller);
  const s = score.data;
  if (!s) return <Skeleton className="h-5 w-20" />;
  if (!s.eligible) return <Chip>New seller</Chip>;
  const rating = s.ratedRetained > 0n ? Number((s.weightedRatingSum * 1000n) / s.ratedRetained) / 1000 : null;
  return (
    <Chip tone="ok" title="Seller rating, weighted by each rated sale’s price minus its refund">
      {rating !== null ? (
        <>
          <span aria-hidden>★</span> {fmtDec(rating, 1)} seller
        </>
      ) : (
        `${s.qualifyingTx.toString()} sales`
      )}
    </Chip>
  );
}

function ModelRow({ m }: { m: ModelResult }) {
  const runs = modelRuns(m);
  const pct = Math.min(100, m.purchased.pass1Rounded ?? 0);
  const noValid = m.status === "run" && !runs.ran;
  const name = modelName(m.requested);
  const label = runs.ran ? `${name}: ${fmtPass(m.purchased.pass1Rounded)} solved` : noValid ? `${name}: no valid runs, ${infraText(runs)}` : `${name}: ${m.status}`;
  return (
    <li className="grid grid-cols-[5rem_minmax(0,1fr)_2.5rem] items-center gap-x-2 text-[11px]" title={runs.infra > 0 ? infraText(runs) : m.requested}>
      <span className="truncate text-muted">{name}</span>
      <span className="h-1 overflow-hidden rounded-full bg-line" role="img" aria-label={label}>
        {runs.ran && <span className={cx("block h-full rounded-full", runs.infraMostly ? "bg-faint" : "bg-accent")} style={{ width: `${pct}%` }} />}
      </span>
      <span className="text-right font-mono tabular-nums">
        {runs.ran ? (
          <span className={runs.infraMostly ? "text-faint" : "text-ink/85"}>{fmtPass(m.purchased.pass1Rounded)}</span>
        ) : noValid ? (
          <span className="text-warn">infra</span>
        ) : (
          <span className="text-faint">{m.status}</span>
        )}
      </span>
    </li>
  );
}

export function EnvCardSkeleton() {
  return (
    <li aria-hidden className="flex flex-col rounded-lg border border-line bg-panel">
      <div className="space-y-2 p-4">
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-4 w-full" />
      </div>
      <div className="space-y-2 border-t border-line px-4 py-3.5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
      <div className="flex justify-between gap-3 border-t border-line px-4 py-3">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-5 w-20" />
      </div>
    </li>
  );
}

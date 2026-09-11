"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState, type ReactNode } from "react";
import { DeploymentGate, TeeMissingNotice } from "@/components/gate";
import { BuyPanel } from "@/components/buy-panel";
import { ReportDetails, ReportScores, useReportCheck } from "@/components/report-panel";
import { EnvRating, SellerLine } from "@/components/version-card";
import { BackLink, Chip, DetailSection, Details, Empty, FullHash, HashValue, Notice, Skeleton, Verified } from "@/components/ui";
import { describe, useDoc } from "@/lib/docs";
import { fmtTime, fmtUsdc, fmtWindow, pct } from "@/lib/format";
import { readOptional, useMarketParams, usePreviewInfo, useVersion, useVersionStats, type Version } from "@/lib/market";

export function parseId(id: string): bigint | null {
  return /^\d+$/.test(id) && id.length < 30 ? BigInt(id) : null;
}

export function ListingView({ id }: { id: string }) {
  return (
    <DeploymentGate>
      <Inner id={parseId(id)} raw={id} />
    </DeploymentGate>
  );
}

function Inner({ id, raw }: { id: bigint | null; raw: string }) {
  const q = useVersion(id);
  const back = (
    <Link href="/" className="btn btn-sm">
      All environments
    </Link>
  );
  if (id === null)
    return (
      <Empty title={`“${raw}” isn’t an environment number`} action={back}>
        Environment links end in a whole number, like /listing/1.
      </Empty>
    );
  if (q.isLoading)
    return (
      <div className="space-y-8" aria-busy="true" aria-label="Loading environment…">
        <div className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  if (q.error || !q.data)
    return (
      <Empty title={`Environment #${raw} not found`} action={back}>
        {(q.error as Error | null)?.message}
      </Empty>
    );
  return <Listing v={q.data} />;
}

function Listing({ v }: { v: Version }) {
  const desc = useDoc(v.uri, v.descriptionHash);
  const manifest = useDoc(v.uri, v.manifestHash);
  const d = describe(desc.data?.json);
  const license = (manifest.data?.json?.license as Record<string, unknown> | undefined)?.id;
  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <BackLink href="/">All environments</BackLink>
        <div className="max-w-3xl space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[32px] sm:leading-10">
            {desc.isLoading ? <Skeleton className="h-9 w-96 max-w-full" /> : (d.title ?? `Environment #${v.id}`)}
          </h1>
          {d.summary && <p className="max-w-[68ch] text-[15px] leading-relaxed text-muted">{d.summary}</p>}
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3 pt-1">
          <Fact label="Tasks" value={v.taskCount} />
          <Fact label="Audit tasks" value={v.auditTaskCount} />
          {d.environmentType && <Fact label="Type" value={d.environmentType} />}
          {d.environmentVersion && <Fact label="Version" value={d.environmentVersion} />}
          {typeof license === "string" && <Fact label="License" value={license} />}
        </dl>
      </header>

      <TeeMissingNotice />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
        <div className="min-w-0 space-y-12">
          <ReportScores v={v} />
          <Claims v={v} />
          <TechnicalDetails v={v} />
        </div>
        <aside aria-label="Buy" className="space-y-6 lg:sticky lg:top-24 lg:self-start">
          <BuyBox v={v} />
          <TrackRecord v={v} />
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="section-title">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-ink tabular-nums [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

/** Claims beyond this many collapse behind a "Show all" button. */
const CLAIMS_SHOWN = 4;

function Claims({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.descriptionHash);
  const d = describe(q.data?.json);
  const [showAll, setShowAll] = useState(false);
  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.error)
    return (
      <Notice tone="bad" title="description.json failed to load">
        {(q.error as Error).message}
      </Notice>
    );
  return (
    <section aria-labelledby="claims-title" className="space-y-3">
      <h2 id="claims-title" className="text-base font-semibold text-ink">
        Seller claims <span className="font-mono text-sm font-normal text-muted tabular-nums">{d.claims.length}</span>
      </h2>
      {q.data && !q.data.ok && <Notice tone="bad" title="description.json sha256 ≠ on-chain descriptionHash" />}
      {d.claims.length ? (
        <>
          <ol id="claims-list" className="divide-y divide-line border-y border-line">
            {(showAll ? d.claims : d.claims.slice(0, CLAIMS_SHOWN)).map((c) => (
              <li key={c.id} id={`claim-${c.id}`} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 py-3 text-sm">
                <span className="font-mono text-xs leading-6 text-muted">{c.id}</span>
                <div className="min-w-0 space-y-1.5">
                  {c.category && <Chip>{c.category}</Chip>}
                  <p className="leading-relaxed text-ink [overflow-wrap:anywhere]">{c.text}</p>
                  {c.check && (
                    <p className="text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
                      <span className="font-medium">Check:</span> {c.check}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {d.claims.length > CLAIMS_SHOWN && (
            <button type="button" className="btn btn-sm btn-ghost -ml-2.5" aria-expanded={showAll} aria-controls="claims-list" onClick={() => setShowAll((x) => !x)}>
              {showAll ? "Show fewer" : `Show all ${d.claims.length} claims`}
            </button>
          )}
        </>
      ) : (
        <p className="text-[13px] text-muted">No claims.</p>
      )}
    </section>
  );
}

/* --------------------------------- buy box --------------------------------- */

/** Price and every term the contract copies into a purchase: VersionTerms + the market params it snapshots. */
function BuyBox({ v }: { v: Version }) {
  const params = useMarketParams();
  const p = params.data;
  const perTask = v.taskCount ? v.price / BigInt(v.taskCount) : 0n;
  const cap = p ? (v.price * BigInt(p.refundCapBps)) / 10000n : undefined;
  const pending = <span className="text-faint">…</span>;
  return (
    <section className="card p-5">
      <div className="font-mono text-2xl leading-none font-medium whitespace-nowrap text-ink tabular-nums">{fmtUsdc(v.price)}</div>
      <div className="mt-1.5 font-mono text-xs text-muted tabular-nums">{fmtUsdc(perTask)} per task</div>
      <dl className="kv mt-4 text-xs [&>dd]:font-mono [&>dd]:tabular-nums">
        <dt>Delivery window</dt>
        <dd>{fmtWindow(v.deliveryWindow)}</dd>
        <dt>Challenge window</dt>
        <dd>{fmtWindow(v.challengeWindow)}</dd>
        <dt>Seller collateral</dt>
        <dd>{fmtUsdc(v.collateral)}</dd>
        <dt>Refund cap</dt>
        <dd>{p ? `${pct(p.refundCapBps)} (${fmtUsdc(cap)})` : pending}</dd>
        <dt>Dispute bond</dt>
        <dd>{p ? `${fmtUsdc(p.bondFloor, { symbol: false })}–${fmtUsdc(p.bondCap)}` : pending}</dd>
        <dt>Case fee</dt>
        <dd>{p ? fmtUsdc(p.caseFee) : pending}</dd>
        <dt>Penalty</dt>
        <dd>{p ? `${pct(p.penaltyBps)} if > ${pct(p.penaltyThresholdBps)} of tasks defective` : pending}</dd>
        <dt>Market fee</dt>
        <dd>{p ? pct(p.feeBps) : pending}</dd>
      </dl>
      <div className="mt-5 border-t border-line pt-5">
        <BuyPanel v={v} />
      </div>
    </section>
  );
}

function TrackRecord({ v }: { v: Version }) {
  const s = useVersionStats(v.id);
  return (
    <section aria-label="Track record" className="space-y-3 px-1 text-xs">
      <SellerLine seller={v.seller} />
      {!s.data ? (
        <Skeleton className="h-4 w-48" />
      ) : (
        <>
          <EnvRating stats={s.data} />
          <dl className="kv text-xs [&>dd]:font-mono [&>dd]:tabular-nums">
            <dt>Settled sales</dt>
            <dd>{s.data.settledCount}</dd>
            <dt>Disputes opened</dt>
            <dd>{s.data.disputesOpened}</dd>
            <dt>Disputes upheld</dt>
            <dd>{s.data.disputesUpheld}</dd>
            <dt>Retained volume</dt>
            <dd>{fmtUsdc(s.data.retainedVolume)}</dd>
          </dl>
        </>
      )}
    </section>
  );
}

/* ------------------------------ Details: everything technical ------------------------------ */

function TechnicalDetails({ v }: { v: Version }) {
  const report = useReportCheck(v);
  const desc = useDoc(v.uri, v.descriptionHash);
  const manifest = useDoc(v.uri, v.manifestHash);
  const filesOk = !desc.error && !manifest.error && desc.data?.ok !== false && manifest.data?.ok !== false;
  const filesPending = desc.isLoading || manifest.isLoading;
  const status = report.status === "bad" || (!filesPending && !filesOk) ? "bad" : report.status === "pending" || filesPending ? "pending" : report.status === "ok" ? "ok" : "neutral";
  const summary =
    status === "ok"
      ? "Technical details · report, description and manifest verified"
      : status === "pending"
        ? "Technical details · verifying…"
        : status === "bad" && !filesOk && !filesPending
          ? "Technical details · a listing file doesn’t match its on-chain hash"
          : `Technical details · ${report.text}`;
  return (
    <Details summary={summary} status={status} id="verify">
      <ReportDetails v={v} />
      <DescriptionDetails v={v} />
      <ManifestDetails v={v} />
      <OnChainVersion v={v} />
      <PreviewFee v={v} />
    </Details>
  );
}

/** Description fields not already shown above the fold (title, summary, type, version, claims). */
const SHOWN_DESC = new Set(["title", "summary", "environmentType", "environmentVersion", "claims"]);

function DescriptionDetails({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.descriptionHash);
  const rest = Object.fromEntries(Object.entries(q.data?.json ?? {}).filter(([k]) => !SHOWN_DESC.has(k)));
  return (
    <DetailSection title="description.json">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Verified ok={q.error ? false : q.data?.ok} pending={q.isLoading} okText="sha256 = descriptionHash" badText={q.error ? "unavailable" : "sha256 ≠ descriptionHash"} title={q.data ? `computed ${q.data.computed}` : undefined} />
        {q.data && (
          <a href={q.data.url} target="_blank" rel="noreferrer" className="link">
            Raw file
          </a>
        )}
        {q.error && <span className="text-bad">{(q.error as Error).message}</span>}
      </div>
      {Object.keys(rest).length > 0 && (
        <div className="mt-3">
          <JsonFields obj={rest} />
        </div>
      )}
    </DetailSection>
  );
}

function ManifestDetails({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.manifestHash);
  const lic = useDoc(v.uri, v.licenseHash);
  const m = q.data?.json ?? null;
  return (
    <DetailSection title="manifest.json">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Verified ok={q.error ? false : q.data?.ok} pending={q.isLoading} okText="sha256 = manifestHash" badText={q.error ? "unavailable" : "sha256 ≠ manifestHash"} title={q.data ? `computed ${q.data.computed}` : undefined} />
        <Verified ok={lic.error ? false : lic.data?.ok} pending={lic.isLoading} okText="license sha256 = licenseHash" badText={lic.error ? "license unavailable" : "license sha256 ≠ licenseHash"} />
        {q.data && (
          <a href={q.data.url} target="_blank" rel="noreferrer" className="link">
            Raw file
          </a>
        )}
        {lic.data && (
          <a href={lic.data.url} target="_blank" rel="noreferrer" className="link">
            License text
          </a>
        )}
        {q.error && <span className="text-bad">{(q.error as Error).message}</span>}
      </div>
      {m ? (
        <div className="mt-3">
          <JsonFields obj={m} />
        </div>
      ) : (
        q.data && <p className="mt-2 text-xs text-bad">manifest.json is not valid JSON.</p>
      )}
    </DetailSection>
  );
}

/* ------------------------------ generic JSON rendering ------------------------------ */

const isNested = (x: unknown) => x !== null && typeof x === "object" && !(Array.isArray(x) && x.every((y) => y === null || typeof y !== "object"));

/** Every key of a JSON object: scalars in a key/value list, objects in collapsible blocks. Nothing is renamed or dropped. */
function JsonFields({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  const flat = entries.filter(([, x]) => !isNested(x));
  const nested = entries.filter(([, x]) => isNested(x));
  return (
    <div className="space-y-2">
      {flat.length > 0 && (
        <dl className="kv">
          {flat.map(([k, x]) => (
            <Fragment key={k}>
              <dt className="font-mono text-xs">{k}</dt>
              <dd>
                <JsonValue v={x} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {nested.map(([k, x]) => (
        <details key={k} className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-muted hover:text-ink">{k}</summary>
          <div className="border-t border-line px-3 py-2.5 text-[13px]">
            <JsonValue v={x} />
          </div>
        </details>
      ))}
    </div>
  );
}

function JsonValue({ v }: { v: unknown }): ReactNode {
  if (v === null || v === undefined) return <span className="font-mono text-xs text-faint">null</span>;
  if (typeof v === "boolean" || typeof v === "number") return <span className="font-mono text-xs tabular-nums">{String(v)}</span>;
  if (typeof v === "string") return /^0x[0-9a-fA-F]{64}$/.test(v) ? <HashValue value={v} /> : <span className="[overflow-wrap:anywhere]">{v}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="font-mono text-xs text-faint">[]</span>;
    return (
      <ul className="flex flex-wrap gap-1.5">
        {v.map((x, i) => (
          <li key={i} className={`min-w-0 rounded border border-line px-1.5 py-0.5 ${x !== null && typeof x === "object" ? "w-full" : ""}`}>
            <JsonValue v={x} />
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return <span className="font-mono text-xs text-faint">{"{}"}</span>;
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, x]) => (
        <div key={k} className="min-w-0">
          <dt className="font-mono text-xs text-muted">{k}</dt>
          <dd className="min-w-0 border-l border-line pl-3">
            <JsonValue v={x} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------ contract state ------------------------------ */

/** getVersion fields not shown elsewhere on the page (price, windows, counts and seller are above), plus listingVersionIds. */
function OnChainVersion({ v }: { v: Version }) {
  const versions = useQuery({
    queryKey: ["listing-versions", v.listingId.toString()],
    queryFn: async () => ((await readOptional("listingVersionIds", [v.listingId])) as bigint[] | undefined) ?? [],
  });
  const hashes: [string, string][] = [
    ["bundleHash", v.bundleHash],
    ["ciphertextHash", v.ciphertextHash],
    ["imageDigest", v.imageDigest],
    ["descriptionHash", v.descriptionHash],
    ["manifestHash", v.manifestHash],
    ["licenseHash", v.licenseHash],
    ["taskRoot", v.taskRoot],
    ["auditRoot", v.auditRoot],
    ["reportHash", v.reportHash],
  ];
  const row = "grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]";
  return (
    <DetailSection title="getVersion">
      <dl className="space-y-2.5 text-[13px]">
        <div className={row}>
          <dt className="font-mono text-xs text-muted">versionId</dt>
          <dd className="font-mono text-xs tabular-nums">{v.id.toString()}</dd>
        </div>
        <div className={row}>
          <dt className="font-mono text-xs text-muted">listingId</dt>
          <dd className="font-mono text-xs tabular-nums">{v.listingId.toString()}</dd>
        </div>
        <div className={row}>
          <dt className="font-mono text-xs text-muted">versionNo</dt>
          <dd className="font-mono text-xs tabular-nums">{v.versionNo}</dd>
        </div>
        <div className={row}>
          <dt className="font-mono text-xs text-muted">active</dt>
          <dd>
            <Chip tone={v.active ? "ok" : "warn"}>{String(v.active)}</Chip>
          </dd>
        </div>
        {hashes.map(([k, val]) => (
          <div key={k} className={row}>
            <dt className="font-mono text-xs text-muted">{k}</dt>
            <dd className="min-w-0">
              <FullHash value={val} />
            </dd>
          </div>
        ))}
        <div className={row}>
          <dt className="font-mono text-xs text-muted">uri</dt>
          <dd className="font-mono text-xs [overflow-wrap:anywhere]">{v.uri || <span className="text-faint">{'""'}</span>}</dd>
        </div>
        {(versions.data?.length ?? 0) > 1 && (
          <div className={row}>
            <dt className="font-mono text-xs text-muted">listingVersionIds</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
              {versions.data!.map((x) =>
                x === v.id ? (
                  <span key={x.toString()} className="text-ink">
                    {x.toString()}
                  </span>
                ) : (
                  <Link key={x.toString()} href={`/listing/${x}`} className="link">
                    {x.toString()}
                  </Link>
                ),
              )}
            </dd>
          </div>
        )}
      </dl>
    </DetailSection>
  );
}

function PreviewFee({ v }: { v: Version }) {
  const q = usePreviewInfo(v.id);
  const pi = q.data;
  if (q.isLoading || pi === undefined || pi === null) return null; // null: deployment without seller-paid previews
  return (
    <DetailSection title="previewInfo">
      <dl className="kv">
        <dt className="font-mono text-xs">fee</dt>
        <dd className="font-mono text-xs tabular-nums">{fmtUsdc(pi.fee)}</dd>
        <dt className="font-mono text-xs">paidAt</dt>
        <dd className="text-xs">{fmtTime(pi.paidAt)}</dd>
        <dt className="font-mono text-xs">quoteHash</dt>
        <dd>
          <HashValue value={pi.quoteHash} />
        </dd>
        <dt className="font-mono text-xs">released</dt>
        <dd className="font-mono text-xs">{String(pi.released)}</dd>
        <dt className="font-mono text-xs">reclaimed</dt>
        <dd className="font-mono text-xs">{String(pi.reclaimed)}</dd>
        <dt className="font-mono text-xs">previewDeadline</dt>
        <dd className="text-xs">{fmtTime(pi.deadline)}</dd>
      </dl>
    </DetailSection>
  );
}

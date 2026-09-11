"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DeploymentGate, TeeMissingNotice } from "@/components/gate";
import { BuyPanel } from "@/components/buy-panel";
import { ReportDetails, ReportScores, useReportCheck } from "@/components/report-panel";
import { EnvRating, SellerLine } from "@/components/version-card";
import { AddressLink, BackLink, Chip, DetailSection, Details, Empty, HashValue, Notice, Skeleton, Verified } from "@/components/ui";
import { describe, useDoc } from "@/lib/docs";
import { fmtTime, fmtUsdc, fmtWindow, pct } from "@/lib/format";
import { isZeroHash, readOptional, useMarketParams, usePreviewInfo, useVersion, useVersionStats, type Version } from "@/lib/market";

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
        {q.error ? "It may not be listed yet, or the network didn’t answer. Check the number, or try again in a moment." : "There’s no environment with this number on the market."}
      </Empty>
    );
  return <Listing v={q.data} />;
}

function Listing({ v }: { v: Version }) {
  const desc = useDoc(v.uri, v.descriptionHash);
  const manifest = useDoc(v.uri, v.manifestHash);
  const d = describe(desc.data?.json);
  const m = manifest.data?.json ?? null;
  const license = licenseLine(m?.license);
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
        {d.skills.length > 0 && (
          <ul aria-label="Skills it trains" className="flex flex-wrap gap-1.5">
            {d.skills.map((s) => (
              <li key={s}>
                <Chip>{s}</Chip>
              </li>
            ))}
          </ul>
        )}
        <dl className="flex flex-wrap gap-x-8 gap-y-3 pt-1">
          <Fact label="Tasks" value={`${v.taskCount}`} note={v.auditTaskCount ? `+${v.auditTaskCount} held back for checks` : undefined} />
          {Boolean(d.environmentType || m?.environmentType) && <Fact label="Type" value={String(d.environmentType ?? m?.environmentType)} />}
          {license && <Fact label="License" value={license} />}
          <Fact label="Time to check" value={fmtWindow(v.challengeWindow)} note="after delivery" />
        </dl>
        {!v.active && <Notice tone="warn" title="Not for sale">The seller has taken this version off the market.</Notice>}
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

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="section-title">{label}</dt>
      <dd className="mt-1 text-sm text-ink">
        <span className="font-mono tabular-nums">{value}</span>
        {note && <span className="ml-1.5 text-xs text-muted">{note}</span>}
      </dd>
    </div>
  );
}

/** "MIT", "CC-BY-4.0 · commercial use" … from whatever shape manifest.license has. */
function licenseLine(l: unknown): string | null {
  if (!l) return null;
  if (typeof l === "string") return l.length > 40 ? `${l.slice(0, 40)}…` : l;
  if (typeof l === "object") {
    const o = l as Record<string, unknown>;
    const v = o.spdx ?? o.id ?? o.name ?? o.type;
    return typeof v === "string" ? v : null;
  }
  return null;
}

function Claims({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.descriptionHash);
  const d = describe(q.data?.json);
  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.error)
    return (
      <Notice tone="bad" title="The seller’s description couldn’t be loaded">
        The file that lists the seller’s claims didn’t download. Try again later, and don’t buy until it loads.
      </Notice>
    );
  return (
    <section aria-labelledby="claims-title" className="space-y-3">
      <div>
        <h2 id="claims-title" className="text-base font-semibold text-ink">
          What the seller claims
        </h2>
        <p className="mt-1 text-[13px] text-muted">Fixed when this version was listed. If one turns out false, you can report it and get money back for the affected tasks.</p>
      </div>
      {q.data && !q.data.ok && (
        <Notice tone="bad" title="This description doesn’t match the listing">
          The file served doesn’t match the fingerprint the seller posted. Treat these claims as untrusted.
        </Notice>
      )}
      {d.claims.length ? (
        <ol className="divide-y divide-line border-y border-line">
          {d.claims.map((c) => (
            <li key={c.id} className="flex gap-4 py-3 text-sm">
              <span className="w-8 shrink-0 font-mono text-xs leading-6 text-muted">{c.id}</span>
              <span className="min-w-0 leading-relaxed text-ink [overflow-wrap:anywhere]">{c.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-muted">The description lists no claims.</p>
      )}
    </section>
  );
}

/* --------------------------------- buy box --------------------------------- */

function BuyBox({ v }: { v: Version }) {
  const params = useMarketParams();
  const p = params.data;
  const perTask = v.taskCount ? v.price / BigInt(v.taskCount) : 0n;
  return (
    <section className="card p-5">
      <div className="font-mono text-2xl leading-none font-medium whitespace-nowrap text-ink tabular-nums">{fmtUsdc(v.price)}</div>
      <div className="mt-1.5 font-mono text-xs text-muted tabular-nums">{fmtUsdc(perTask)} per task</div>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        Full refund if not delivered within {fmtWindow(v.deliveryWindow)}
        {p ? ` · up to ${pct(p.refundCapBps)} back for defective tasks within ${fmtWindow(v.challengeWindow)} of delivery` : ""}.
      </p>
      <div className="mt-5 border-t border-line pt-5">
        <BuyPanel v={v} />
      </div>
    </section>
  );
}

function TrackRecord({ v }: { v: Version }) {
  const s = useVersionStats(v.id);
  return (
    <section aria-label="Track record" className="space-y-2 px-1 text-xs">
      <SellerLine seller={v.seller} link />
      {!s.data ? (
        <Skeleton className="h-4 w-48" />
      ) : (
        <>
          <EnvRating stats={s.data} />
          <div className="text-muted">
            <span className="font-mono tabular-nums text-ink">{s.data.settledCount}</span> completed sales · <span className="font-mono tabular-nums text-ink">{s.data.disputesOpened}</span> problems reported ·{" "}
            <span className="font-mono tabular-nums text-ink">{s.data.disputesUpheld}</span> upheld
          </div>
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
      ? "Verified in your browser · report signed, files match the listing"
      : status === "pending"
        ? "Checking the signed report and listing files…"
        : status === "bad"
          ? `${!filesOk && !filesPending ? "A listing file doesn’t match its fingerprint" : report.text} · see details`
          : `${report.text} · technical details`;
  return (
    <Details summary={summary} status={status} id="verify">
      <ReportDetails v={v} />
      <DescriptionDetails v={v} />
      <ManifestDetails v={v} />
      <Commitments v={v} />
      <TermsDetails v={v} />
      <PreviewFee v={v} />
      <OtherVersions v={v} />
    </Details>
  );
}

function DescriptionDetails({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.descriptionHash);
  const d = describe(q.data?.json);
  const rest = Object.entries(d.raw).filter(([k]) => !SKIP_DESC.has(k));
  return (
    <DetailSection title="Description file">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Verified
          ok={q.error ? false : q.data?.ok}
          pending={q.isLoading}
          okText="sha256 = on-chain descriptionHash"
          badText={q.error ? "unavailable" : "sha256 ≠ on-chain"}
          title={q.data ? `computed ${q.data.computed}` : undefined}
        />
        {q.data && (
          <a href={q.data.url} target="_blank" rel="noreferrer" className="link">
            Raw description.json
          </a>
        )}
        {q.error && <span className="text-bad">{(q.error as Error).message}</span>}
      </div>
      {d.claims.some((c) => c.category) && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {d.claims
            .filter((c) => c.category)
            .map((c) => (
              <li key={c.id}>
                <span className="font-mono">{c.id}</span> category: {c.category}
              </li>
            ))}
        </ul>
      )}
      {rest.length > 0 && (
        <dl className="kv mt-3">
          {rest.map(([k, val]) => (
            <Row key={k} k={k} v={val} />
          ))}
        </dl>
      )}
    </DetailSection>
  );
}

const SKIP_DESC = new Set(["schemaVersion", "title", "summary", "claims", "skills", "targetSkills", "environmentType", "environmentVersion", "tags", "skillTags"]);

function Row({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt className="capitalize">{k.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
      <dd>
        <Value v={v} />
      </dd>
    </>
  );
}

function Value({ v }: { v: unknown }): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-faint">none</span>;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return /^0x[0-9a-fA-F]{64}$/.test(v) ? <HashValue value={v} /> : v;
  if (typeof v === "number") return <span className="tabular-nums">{v.toLocaleString()}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-faint">none</span>;
    if (v.every((x) => typeof x !== "object")) return v.join(", ");
    return (
      <ul className="space-y-1">
        {v.map((x, i) => (
          <li key={i} className="rounded border border-line px-2 py-1 text-xs">
            <Value v={x} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <span className="text-xs">
      {Object.entries(v as Record<string, unknown>).map(([k, x]) => (
        <span key={k} className="mr-3 inline-block">
          <span className="text-muted">{k}:</span> <Value v={x} />
        </span>
      ))}
    </span>
  );
}

const MANIFEST_SECTIONS: { key: string; title: string }[] = [
  { key: "resources", title: "Resources" },
  { key: "determinism", title: "Determinism" },
  { key: "networkPolicy", title: "Network policy" },
  { key: "license", title: "License" },
  { key: "provenance", title: "Provenance" },
  { key: "conflicts", title: "Conflicts of interest" },
  { key: "grader", title: "Grader" },
  { key: "entrypoints", title: "Entrypoints" },
  { key: "referenceProtocol", title: "Reference protocol" },
];

function ManifestDetails({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.manifestHash);
  const lic = useDoc(v.uri, v.licenseHash);
  const m = q.data?.json ?? null;
  return (
    <DetailSection title="Manifest" hint="manifest.json ships inside the bundle; this public copy is checked against the on-chain manifestHash.">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Verified ok={q.error ? false : q.data?.ok} pending={q.isLoading} okText="sha256 = on-chain manifestHash" badText={q.error ? "unavailable" : "sha256 ≠ on-chain"} />
        <Verified ok={lic.error ? false : lic.data?.ok} pending={lic.isLoading} okText="license sha256 = on-chain licenseHash" badText={lic.error ? "license unavailable" : "license mismatch"} />
        {lic.data && (
          <a href={lic.data.url} target="_blank" rel="noreferrer" className="link">
            Read license
          </a>
        )}
        {q.data && (
          <a href={q.data.url} target="_blank" rel="noreferrer" className="link">
            Raw manifest.json
          </a>
        )}
      </div>
      {!m ? (
        !q.isLoading && <p className="mt-2 text-xs text-muted">{(q.error as Error)?.message ?? "Could not parse manifest.json."}</p>
      ) : (
        <div className="mt-3 space-y-4">
          <dl className="kv">
            <dt>Image</dt>
            <dd className="font-mono text-xs [overflow-wrap:anywhere]">{String(m.imageRef ?? "—")}</dd>
            <dt>Tasks / audit</dt>
            <dd className="font-mono tabular-nums">
              {String(m.taskCount ?? v.taskCount)} / {String(m.auditTaskCount ?? v.auditTaskCount)}
            </dd>
          </dl>
          {MANIFEST_SECTIONS.filter((s) => m[s.key] !== undefined).map((s) => (
            <div key={s.key}>
              <div className="text-xs font-medium text-ink">{s.title}</div>
              <dl className="kv mt-1.5">
                {typeof m[s.key] === "object" && m[s.key] !== null && !Array.isArray(m[s.key]) ? (
                  Object.entries(m[s.key] as Record<string, unknown>).map(([k, val]) => <Row key={k} k={k} v={val} />)
                ) : (
                  <Row k={s.key} v={m[s.key]} />
                )}
              </dl>
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  );
}

function Commitments({ v }: { v: Version }) {
  const rows: [string, string, string][] = [
    ["bundleHash", v.bundleHash, "sha256 of the plaintext tar you receive; checked in your browser after decryption."],
    ["ciphertextHash", v.ciphertextHash, "sha256 of the encrypted bundle; the relay’s delivery receipt must match it."],
    ["taskRoot", v.taskRoot, `Merkle root over ${v.taskCount} salted purchased-task commitments.`],
    ["auditRoot", v.auditRoot, `Merkle root over ${v.auditTaskCount} audit-holdout tasks (never delivered).`],
    ["imageDigest", v.imageDigest, "sha256 digest of the runtime container image."],
    ["descriptionHash", v.descriptionHash, "sha256 of description.json."],
    ["manifestHash", v.manifestHash, "sha256 of manifest.json."],
    ["licenseHash", v.licenseHash, "sha256 of the license text."],
    ["reportHash", v.reportHash, "sha256 of the signed preview report (set once by attachReport)."],
  ];
  return (
    <DetailSection title="On-chain commitments" hint="Hashes prove you later receive exactly this version. They say nothing about quality, ownership, or originality.">
      <dl className="space-y-3 text-[13px]">
        {rows.map(([k, val, hint]) => (
          <div key={k} className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="font-mono text-xs text-muted">{k}</dt>
            <dd className="min-w-0">
              <HashValue value={val} full />
              <div className="text-xs text-muted">{hint}</div>
            </dd>
          </div>
        ))}
        <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-mono text-xs text-muted">uri</dt>
          <dd className="font-mono text-xs [overflow-wrap:anywhere]">{v.uri || "—"}</dd>
        </div>
      </dl>
    </DetailSection>
  );
}

function TermsDetails({ v }: { v: Version }) {
  const params = useMarketParams();
  const p = params.data;
  const cap = p ? (v.price * BigInt(p.refundCapBps)) / 10000n : undefined;
  return (
    <DetailSection title="Full terms" hint="Copied into your purchase when you pay; later changes never apply to it.">
      <dl className="kv">
        <dt>Listing / version</dt>
        <dd className="font-mono tabular-nums">
          listing #{v.listingId.toString()} · version {v.versionNo} · id {v.id.toString()}
        </dd>
        <dt>Seller</dt>
        <dd>
          <AddressLink address={v.seller} seller />
        </dd>
        <dt>Delivery window</dt>
        <dd>{fmtWindow(v.deliveryWindow)}; after that anyone can trigger a full refund</dd>
        <dt>Challenge window</dt>
        <dd>{fmtWindow(v.challengeWindow)} after the key is delivered</dd>
        <dt>Refund cap</dt>
        <dd>{p ? `${pct(p.refundCapBps)} of price (${fmtUsdc(cap)}) after delivery; each task refunded once` : "…"}</dd>
        <dt>Dispute bond</dt>
        <dd>{p ? `requested refund, clamped to ${fmtUsdc(p.bondFloor, { symbol: false })}–${fmtUsdc(p.bondCap)}; returned if you win` : "…"}</dd>
        <dt>Case fee</dt>
        <dd>{p ? `${fmtUsdc(p.caseFee)}, paid by the losing side` : "…"}</dd>
        <dt>Seller collateral</dt>
        <dd>{fmtUsdc(v.collateral)} reserved for your purchase</dd>
        <dt>Extra penalty</dt>
        <dd>{p ? `if more than ${pct(p.penaltyThresholdBps)} of tasks are confirmed defective, ${pct(p.penaltyBps)} of price is slashed from collateral into a neutral reserve` : "…"}</dd>
        <dt>Marketplace fee</dt>
        <dd>{p ? `${pct(p.feeBps)} of what the seller keeps` : "…"}</dd>
      </dl>
    </DetailSection>
  );
}

function PreviewFee({ v }: { v: Version }) {
  const q = usePreviewInfo(v.id);
  const pi = q.data;
  if (q.isLoading || pi === undefined || pi === null) return null; // null: deployment without seller-paid previews
  const status = pi.paidAt === 0 ? "not requested" : pi.released ? "released to the TEE operator" : pi.reclaimed ? "reclaimed by the seller" : "escrowed";
  return (
    <DetailSection title="Preview fee" hint="The seller pays for the preview’s inference; the fee goes to the TEE operator only once a signed report is attached.">
      <dl className="kv">
        <dt>Fee</dt>
        <dd className="font-mono tabular-nums">{pi.paidAt ? fmtUsdc(pi.fee) : "—"}</dd>
        <dt>Status</dt>
        <dd>
          <Chip tone={pi.released ? "ok" : pi.reclaimed ? "neutral" : pi.paidAt ? "info" : "neutral"}>{status}</Chip>
        </dd>
        {pi.paidAt > 0 && (
          <>
            <dt>Paid</dt>
            <dd>{fmtTime(pi.paidAt)}</dd>
            <dt>Quote</dt>
            <dd>{isZeroHash(pi.quoteHash) ? <span className="text-muted">none (minimum fee)</span> : <HashValue value={pi.quoteHash} />}</dd>
            {!pi.released && !pi.reclaimed && (
              <>
                <dt>Reclaimable after</dt>
                <dd>{fmtTime(pi.deadline)}</dd>
              </>
            )}
          </>
        )}
      </dl>
    </DetailSection>
  );
}

function OtherVersions({ v }: { v: Version }) {
  const q = useQuery({
    queryKey: ["listing-versions", v.listingId.toString()],
    queryFn: async () => ((await readOptional("listingVersionIds", [v.listingId])) as bigint[] | undefined) ?? [],
  });
  const others = (q.data ?? []).filter((x) => x !== v.id);
  if (!others.length) return null;
  return (
    <DetailSection title="Other versions of this listing" hint="Each version has its own terms, report, and ratings.">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        {others.map((x) => (
          <li key={x.toString()}>
            <Link href={`/listing/${x}`} className="link">
              Version id {x.toString()}
            </Link>
          </li>
        ))}
      </ul>
    </DetailSection>
  );
}

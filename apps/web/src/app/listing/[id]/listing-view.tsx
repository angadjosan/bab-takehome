"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DeploymentGate, TeeMissingNotice } from "@/components/gate";
import { BuyPanel } from "@/components/buy-panel";
import { ReportPanel } from "@/components/report-panel";
import { EnvRating, SellerLine } from "@/components/version-card";
import { AddressLink, Card, Empty, HashValue, Notice, Skeleton, Verified } from "@/components/ui";
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
  if (id === null) return <Empty title={`“${raw}” is not a version id`}>Version ids are positive integers.</Empty>;
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  if (q.error || !q.data)
    return (
      <Empty title={`Environment version #${raw} not found`}>
        {(q.error as Error)?.message ?? "No such version on this chain."}{" "}
        <Link href="/" className="link">
          Back to the marketplace
        </Link>
      </Empty>
    );
  return <Listing v={q.data} />;
}

function Listing({ v }: { v: Version }) {
  const desc = useDoc(v.uri, v.descriptionHash);
  const d = describe(desc.data?.json);
  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs text-muted hover:text-ink">
          ← Marketplace
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                Listing #{v.listingId.toString()} · version {v.versionNo} · version id {v.id.toString()}
              </span>
              {d.environmentType && <span className="badge badge-neutral">{d.environmentType}</span>}
              {d.environmentVersion && <span className="badge badge-neutral font-mono">{d.environmentVersion}</span>}
              {!v.active && <span className="badge badge-warn">inactive: not for sale</span>}
            </div>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">{desc.isLoading ? <Skeleton className="h-8 w-80" /> : d.title ?? `Environment version #${v.id}`}</h1>
            {d.summary && <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-muted">{d.summary}</p>}
            <div className="mt-2 text-xs">
              <SellerLine seller={v.seller} link />
            </div>
          </div>
        </div>
      </div>

      <TeeMissingNotice />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <DescriptionCard v={v} />
          <ReportPanel v={v} />
          <ManifestCard v={v} />
          <CommitmentsCard v={v} />
        </div>
        <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <TermsCard v={v} />
          <PreviewFeeCard v={v} />
          <FeedbackCard v={v} />
          <OtherVersions v={v} />
        </aside>
      </div>
    </div>
  );
}

function DescriptionCard({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.descriptionHash);
  const d = describe(q.data?.json);
  return (
    <Card
      title="Description & checkable claims"
      subtitle="Frozen with this version. A “Description is false” dispute must point to one of these numbered claims."
      action={
        <Verified
          ok={q.error ? false : q.data?.ok}
          pending={q.isLoading}
          okText="sha256 = on-chain descriptionHash"
          badText={q.error ? "unavailable" : "sha256 ≠ on-chain"}
          title={q.data ? `computed ${q.data.computed}` : undefined}
        />
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <Notice tone="bad" title="description.json could not be fetched">
          {(q.error as Error).message}
        </Notice>
      ) : (
        <div className="space-y-4">
          {q.data && !q.data.ok && (
            <Notice tone="bad" title="Hash mismatch">
              The document served at {q.data.url} does not match the on-chain descriptionHash. Treat its contents as untrusted.
            </Notice>
          )}
          {d.skills.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="section-title mr-1">Target skills</span>
              {d.skills.map((s) => (
                <span key={s} className="badge badge-accent">
                  {s}
                </span>
              ))}
            </div>
          )}
          {d.claims.length ? (
            <ol className="space-y-2">
              {d.claims.map((c) => (
                <li key={c.id} className="flex gap-3 rounded-lg border border-line p-3 text-sm">
                  <span className="shrink-0 font-mono text-xs font-semibold text-accent">{c.id}</span>
                  <span className="leading-relaxed">{c.text}</span>
                  {c.category && <span className="ml-auto hidden shrink-0 self-start text-[11px] text-muted sm:inline">{c.category}</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">The description lists no claims.</p>
          )}
          <OtherDescriptionFields raw={d.raw} />
          {q.data && (
            <a href={q.data.url} target="_blank" rel="noreferrer" className="link text-xs">
              Raw description.json
            </a>
          )}
        </div>
      )}
    </Card>
  );
}

const SKIP_DESC = new Set(["schemaVersion", "title", "summary", "claims", "skills", "targetSkills", "environmentType", "environmentVersion", "tags", "skillTags"]);
function OtherDescriptionFields({ raw }: { raw: Record<string, unknown> }) {
  const rest = Object.entries(raw).filter(([k]) => !SKIP_DESC.has(k));
  if (!rest.length) return null;
  return (
    <dl className="kv border-t border-line pt-4">
      {rest.map(([k, val]) => (
        <Row key={k} k={k} v={val} />
      ))}
    </dl>
  );
}

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
  if (typeof v === "number") return v.toLocaleString();
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

const MANIFEST_SECTIONS: { key: string; title: string; hint: string }[] = [
  { key: "resources", title: "Resources", hint: "What one episode needs to run." },
  { key: "determinism", title: "Determinism", hint: "Randomness sources, seed policy, and whether results vary." },
  { key: "networkPolicy", title: "Network policy", hint: "Offline, recorded fixtures, or external dependencies." },
  { key: "license", title: "License", hint: "Usage rights granted to buyers." },
  { key: "provenance", title: "Provenance", hint: "Authorship, upstream sources, and funders." },
  { key: "conflicts", title: "Conflicts of interest", hint: "Related parties and disclosures." },
  { key: "grader", title: "Grader", hint: "How success is decided." },
  { key: "entrypoints", title: "Entrypoints", hint: "The environment interface." },
  { key: "referenceProtocol", title: "Reference protocol", hint: "How the preview was run." },
];

function ManifestCard({ v }: { v: Version }) {
  const q = useDoc(v.uri, v.manifestHash);
  const lic = useDoc(v.uri, v.licenseHash);
  const m = q.data?.json ?? null;
  return (
    <Card
      title="Manifest"
      subtitle="manifest.json ships inside the bundle; this public copy is hash-checked against the on-chain manifestHash."
      action={<Verified ok={q.error ? false : q.data?.ok} pending={q.isLoading} okText="sha256 = on-chain manifestHash" badText={q.error ? "unavailable" : "sha256 ≠ on-chain"} />}
    >
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : !m ? (
        <Notice tone="warn" title="Manifest not available">
          {(q.error as Error)?.message ?? "Could not parse manifest.json."}
        </Notice>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <MiniStat label="Environment type" value={String(m.environmentType ?? "—")} />
            <MiniStat label="Image" value={<span className="break-all font-mono text-xs">{String(m.imageRef ?? "—")}</span>} />
            <MiniStat label="Tasks / audit" value={`${String(m.taskCount ?? v.taskCount)} / ${String(m.auditTaskCount ?? v.auditTaskCount)}`} />
          </div>
          {MANIFEST_SECTIONS.filter((s) => m[s.key] !== undefined).map((s) => (
            <details key={s.key} className="group rounded-lg border border-line" open={["resources", "determinism", "networkPolicy", "license", "provenance", "conflicts"].includes(s.key)}>
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm">
                <span className="font-medium">{s.title}</span>
                <span className="text-xs text-muted">{s.hint}</span>
              </summary>
              <dl className="kv border-t border-line px-4 py-3">
                {typeof m[s.key] === "object" && m[s.key] !== null && !Array.isArray(m[s.key]) ? (
                  Object.entries(m[s.key] as Record<string, unknown>).map(([k, val]) => <Row key={k} k={k} v={val} />)
                ) : (
                  <Row k={s.key} v={m[s.key]} />
                )}
              </dl>
            </details>
          ))}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>License text:</span>
            <Verified ok={lic.error ? false : lic.data?.ok} pending={lic.isLoading} okText="sha256 = on-chain licenseHash" badText={lic.error ? "unavailable" : "mismatch"} />
            {lic.data && (
              <a href={lic.data.url} target="_blank" rel="noreferrer" className="link">
                read license
              </a>
            )}
            {q.data && (
              <a href={q.data.url} target="_blank" rel="noreferrer" className="link ml-auto">
                Raw manifest.json
              </a>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-panel-2 px-3 py-2">
      <div className="section-title">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

function CommitmentsCard({ v }: { v: Version }) {
  const rows: [string, string, string][] = [
    ["bundleHash", v.bundleHash, "sha256 of the canonical plaintext tar you receive. Checked in your browser after decryption."],
    ["ciphertextHash", v.ciphertextHash, "sha256 of the encrypted bundle file. The relay’s delivery receipt must match it."],
    ["taskRoot", v.taskRoot, `Merkle root over ${v.taskCount} salted purchased-task commitments.`],
    ["auditRoot", v.auditRoot, `Merkle root over ${v.auditTaskCount} audit-holdout tasks (never delivered).`],
    ["imageDigest", v.imageDigest, "sha256 digest of the exact runtime container image."],
    ["descriptionHash", v.descriptionHash, "sha256 of description.json."],
    ["manifestHash", v.manifestHash, "sha256 of manifest.json."],
    ["licenseHash", v.licenseHash, "sha256 of the license text."],
    ["reportHash", v.reportHash, "sha256 of the signed preview report (set once by attachReport)."],
  ];
  return (
    <Card title="On-chain commitments" subtitle="Hashes prove identity: that you later receive exactly this version. They say nothing about quality, ownership, or originality.">
      <dl className="space-y-3 text-sm">
        {rows.map(([k, val, hint]) => (
          <div key={k} className="grid gap-1 sm:grid-cols-[9rem_1fr]">
            <dt className="font-mono text-xs text-muted">{k}</dt>
            <dd className="min-w-0">
              <HashValue value={val} full />
              <div className="text-xs text-muted">{hint}</div>
            </dd>
          </div>
        ))}
        <div className="grid gap-1 sm:grid-cols-[9rem_1fr]">
          <dt className="font-mono text-xs text-muted">uri</dt>
          <dd className="break-all font-mono text-xs">{v.uri || "—"}</dd>
        </div>
      </dl>
    </Card>
  );
}

function TermsCard({ v }: { v: Version }) {
  const params = useMarketParams();
  const p = params.data;
  const perTask = v.taskCount ? v.price / BigInt(v.taskCount) : 0n;
  const cap = p ? (v.price * BigInt(p.refundCapBps)) / 10000n : undefined;
  return (
    <Card title="Commercial terms" subtitle="Snapshotted into your purchase when you pay; later changes never apply to it.">
      <div className="flex items-baseline justify-between">
        <span className="text-3xl font-semibold tabular-nums">{fmtUsdc(v.price)}</span>
        <span className="text-xs text-muted">{fmtUsdc(perTask)} per task</span>
      </div>
      <dl className="kv mt-4 text-[13px]">
        <dt>Delivery window</dt>
        <dd>{fmtWindow(v.deliveryWindow)}, else anyone can trigger a full refund</dd>
        <dt>Challenge window</dt>
        <dd>{fmtWindow(v.challengeWindow)} after the key is delivered</dd>
        <dt>Refund cap</dt>
        <dd>{p ? `${pct(p.refundCapBps)} of price (${fmtUsdc(cap)})` : "…"} after delivery; each task refunded once</dd>
        <dt>Dispute bond</dt>
        <dd>{p ? `requested refund, clamped to ${fmtUsdc(p.bondFloor, { symbol: false })}–${fmtUsdc(p.bondCap)}; returned if you win` : "…"}</dd>
        <dt>Case fee</dt>
        <dd>{p ? `${fmtUsdc(p.caseFee)}, paid by the losing side` : "…"}</dd>
        <dt>Seller collateral</dt>
        <dd>{fmtUsdc(v.collateral)} reserved for your purchase</dd>
        <dt>Extra penalty</dt>
        <dd>{p ? `if > ${pct(p.penaltyThresholdBps)} of tasks are confirmed defective, ${pct(p.penaltyBps)} of price is slashed from collateral into a neutral reserve` : "…"}</dd>
        <dt>Marketplace fee</dt>
        <dd>{p ? `${pct(p.feeBps)} of what the seller retains` : "…"}</dd>
      </dl>
      <div className="mt-5 border-t border-line pt-5">
        <BuyPanel v={v} />
      </div>
    </Card>
  );
}

function PreviewFeeCard({ v }: { v: Version }) {
  const q = usePreviewInfo(v.id);
  const pi = q.data;
  if (q.isLoading || pi === undefined) return null;
  if (pi === null) return null; // deployment without seller-paid previews
  const status = pi.paidAt === 0 ? "not requested" : pi.released ? "released to the TEE operator" : pi.reclaimed ? "reclaimed by the seller" : "escrowed";
  return (
    <Card title="Preview fee" subtitle="The seller pays the preview’s inference on-chain; the fee is released to the TEE operator only when a signed report is attached.">
      <dl className="kv text-[13px]">
        <dt>Fee</dt>
        <dd>{pi.paidAt ? fmtUsdc(pi.fee) : "—"}</dd>
        <dt>Status</dt>
        <dd>
          <span className={pi.released ? "badge badge-ok" : pi.reclaimed ? "badge badge-neutral" : pi.paidAt ? "badge badge-info" : "badge badge-neutral"}>{status}</span>
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
    </Card>
  );
}

function FeedbackCard({ v }: { v: Version }) {
  const s = useVersionStats(v.id);
  return (
    <Card title="This version’s track record" subtitle="Purchase-linked, from the contract. Separate from seller reputation.">
      {!s.data ? (
        <Skeleton className="h-20" />
      ) : (
        <div className="space-y-3 text-sm">
          <EnvRating stats={s.data} />
          <dl className="kv text-[13px]">
            <dt>Settled purchases</dt>
            <dd>{s.data.settledCount}</dd>
            <dt>Retained volume</dt>
            <dd>{fmtUsdc(s.data.retainedVolume)}</dd>
            <dt>Disputes</dt>
            <dd>
              {s.data.disputesOpened} opened · {s.data.disputesUpheld} upheld
            </dd>
          </dl>
          <p className="text-xs text-muted">
            Seller <AddressLink address={v.seller} seller /> — see stake, qualifying transactions, and counterparties on the seller page.
          </p>
        </div>
      )}
    </Card>
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
    <Card title="Other versions of this listing" subtitle="Each version has its own frozen terms, report, and ratings.">
      <ul className="space-y-1 text-sm">
        {others.map((x) => (
          <li key={x.toString()}>
            <Link href={`/listing/${x}`} className="link">
              Version id {x.toString()}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { tradeRows, useMarketEvents, useVersions, type Version } from "@/lib/market";
import { fmtUsdc } from "@/lib/format";
import { EnvCard, EnvCardSkeleton, type EnvFacts } from "./env-card";
import { Notice, cx } from "./ui";

const SORTS = {
  newest: "Newest",
  priceAsc: "Price ↑",
  priceDesc: "Price ↓",
  perTaskAsc: "Price per task ↑",
  tasks: "Most tasks",
  rating: "Highest rated",
  sold: "Most sold",
  topPassDesc: "Top pass@1 ↓",
  topPassAsc: "Top pass@1 ↑",
} as const;
type SortKey = keyof typeof SORTS;

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
/** Nulls always sort last, whichever direction. */
const cmpNullable = (a: number | null | undefined, b: number | null | undefined, dir: 1 | -1) => {
  const na = a === null || a === undefined;
  const nb = b === null || b === undefined;
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  return (a - b) * dir;
};
const perTask = (v: Version) => (v.taskCount > 0 ? v.price / BigInt(v.taskCount) : null);

function countBy(values: string[]) {
  const m = new Map<string, number>();
  for (const x of values) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function EnvBrowser() {
  const versions = useVersions();
  const events = useMarketEvents();
  const totals = useMemo(() => {
    if (!events.data) return null;
    const rows = tradeRows(events.data);
    const toSellers = events.data.filter((e) => e.eventName === "PurchaseSettled").reduce((s, e) => s + BigInt((e.args.sellerProceeds as bigint | undefined) ?? 0n), 0n);
    const disputes = events.data.filter((e) => e.eventName === "DisputeOpened").length;
    return { purchases: rows.length, toSellers, disputes };
  }, [events.data]);

  const [facts, setFacts] = useState<Record<string, EnvFacts>>({});
  const onFacts = useCallback((id: string, f: EnvFacts) => {
    setFacts((prev) => (prev[id] && JSON.stringify(prev[id]) === JSON.stringify(f) ? prev : { ...prev, [id]: f }));
  }, []);

  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [skill, setSkill] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("newest");

  // Retired versions (setVersionActive false) stay on-chain but are not for sale; hide them.
  const all = useMemo(() => (versions.data ?? []).filter((v) => v.active), [versions.data]);
  const known = all.map((v) => facts[v.id.toString()]).filter((f): f is EnvFacts => !!f);
  const types = countBy(known.flatMap((f) => (f.environmentType ? [f.environmentType] : [])));
  const skills = countBy(known.flatMap((f) => [...new Set(f.skills)]));
  const statuses = countBy(known.map((f) => f.status));

  const sorted = useMemo(() => {
    const fx = (v: Version) => facts[v.id.toString()];
    const byId = (a: Version, b: Version) => cmpBig(b.id, a.id);
    const cmp: Record<SortKey, (a: Version, b: Version) => number> = {
      newest: byId,
      priceAsc: (a, b) => cmpBig(a.price, b.price),
      priceDesc: (a, b) => cmpBig(b.price, a.price),
      perTaskAsc: (a, b) => {
        const pa = perTask(a);
        const pb = perTask(b);
        if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1;
        return cmpBig(pa, pb);
      },
      tasks: (a, b) => b.taskCount - a.taskCount,
      rating: (a, b) => cmpNullable(fx(a)?.rating, fx(b)?.rating, -1),
      sold: (a, b) => (fx(b)?.sold ?? 0) - (fx(a)?.sold ?? 0),
      topPassDesc: (a, b) => cmpNullable(fx(a)?.topPass, fx(b)?.topPass, -1),
      topPassAsc: (a, b) => cmpNullable(fx(a)?.topPass, fx(b)?.topPass, 1),
    };
    return [...all].sort((a, b) => cmp[sort](a, b) || byId(a, b));
  }, [all, facts, sort]);

  const q = query.trim().toLowerCase();
  const matches = (v: Version) => {
    const f = facts[v.id.toString()];
    if (type && f?.environmentType !== type) return false;
    if (skill && !f?.skills.includes(skill)) return false;
    if (status && f?.status !== status) return false;
    if (!q) return true;
    const hay = [f?.title, f?.summary, f?.environmentType, f?.environmentVersion, ...(f?.skills ?? []), v.seller, `#${v.id}`].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  };
  const shown = sorted.filter(matches).length;
  const filtered = !!(q || type || skill || status);
  const clear = () => {
    setQuery("");
    setType(null);
    setSkill(null);
    setStatus(null);
  };

  return (
    <section aria-labelledby="envs-title" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 id="envs-title" className="text-xl font-semibold tracking-tight text-ink">
          Environments
          {versions.data && <span className="ml-2 font-mono text-sm font-normal text-muted tabular-nums">{versions.data.length}</span>}
        </h1>
        {totals && (
          <p className="text-xs text-muted">
            <span className="font-mono text-ink tabular-nums">{totals.purchases}</span> purchase{totals.purchases === 1 ? "" : "s"} ·{" "}
            <span className="font-mono text-ink tabular-nums">{totals.disputes}</span> dispute{totals.disputes === 1 ? "" : "s"} ·{" "}
            <span className="font-mono text-ink tabular-nums">{fmtUsdc(totals.toSellers)}</span> paid to sellers ·{" "}
            <Link href="/activity" className="link">
              Activity
            </Link>
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 border-b border-line pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Environment type" className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 pb-0.5">
          <Pill on={type === null} onClick={() => setType(null)} label="All" count={all.length} />
          {types.map(([k, n]) => (
            <Pill key={k} on={type === k} onClick={() => setType(type === k ? null : k)} label={k} count={n} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
          <label className="min-w-0 flex-1 basis-full sm:basis-auto lg:w-60 lg:flex-none">
            <span className="sr-only">Search environments</span>
            <input type="search" className="input min-h-8! py-1!" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {skills.length > 0 && (
            <Select label="Skill" value={skill ?? ""} onChange={(x) => setSkill(x || null)}>
              <option value="">All skills</option>
              {skills.map(([k, n]) => (
                <option key={k} value={k}>
                  {k} ({n})
                </option>
              ))}
            </Select>
          )}
          {(statuses.length > 1 || status) && (
            <Select label="Status" value={status ?? ""} onChange={(x) => setStatus(x || null)}>
              <option value="">Any status</option>
              {statuses.map(([k, n]) => (
                <option key={k} value={k}>
                  {k} ({n})
                </option>
              ))}
            </Select>
          )}
          <Select label="Sort" value={sort} onChange={(x) => setSort(x as SortKey)}>
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORTS[k]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {filtered && (
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>
            <span className="font-mono text-ink tabular-nums">{shown}</span> / <span className="font-mono tabular-nums">{all.length}</span>
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>
            Clear
          </button>
        </div>
      )}

      {versions.error ? (
        <Notice tone="bad" title="Couldn’t load environments">
          {(versions.error as Error).message.split("\n")[0]}
        </Notice>
      ) : versions.isLoading ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading environments">
          <EnvCardSkeleton />
          <EnvCardSkeleton />
          <EnvCardSkeleton />
        </ul>
      ) : all.length === 0 ? (
        <p className="text-sm text-muted">No environments listed yet.</p>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((v) => (
              <EnvCard key={v.id.toString()} v={v} hidden={!matches(v)} onFacts={onFacts} />
            ))}
          </ul>
          {shown === 0 && <p className="text-sm text-muted">No environments match.</p>}
        </>
      )}
      {events.error && <p className="text-xs text-bad">Activity totals unavailable: {(events.error as Error).message.split("\n")[0]}</p>}
    </section>
  );
}

function Pill({ on, onClick, label, count }: { on: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150",
        on ? "bg-ink text-bg" : "text-muted hover:bg-panel-2 hover:text-ink",
      )}
    >
      {label}
      <span className={cx("font-mono text-[11px] tabular-nums", on ? "text-bg/70" : "text-faint")}>{count}</span>
    </button>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="min-w-0 flex-1 sm:flex-none">
      <span className="sr-only">{label}</span>
      <select className="input min-h-8! py-1! sm:w-auto" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

"use client";

import Link from "next/link";
import { useMemo } from "react";
import { DeploymentGate, TeeMissingNotice } from "@/components/gate";
import { VersionCard } from "@/components/version-card";
import { Empty, Notice, Skeleton, Stat } from "@/components/ui";
import { tradeRows, useMarketEvents, useVersions } from "@/lib/market";
import { fmtUsdc } from "@/lib/format";
import { CHAIN_NAME } from "@/lib/config";

const FLOW = [
  { t: "Signed preview", d: "A TEE runs reference models on the sealed environment and signs pass@1 scores + a screened explanation." },
  { t: "Escrow", d: "You pay into the contract. The seller’s collateral is reserved for your purchase." },
  { t: "Key delivery", d: "The relay wraps the bundle key to your X25519 key and records a signed receipt on-chain." },
  { t: "Challenge window", d: "Inspect the full source, tasks, and tests. File a specific, bonded claim before the deadline." },
  { t: "Disputes", d: "Mechanical claims are rechecked in the TEE; false-description claims go to 3 staked AI jurors." },
  { t: "Reputation", d: "Settled purchases feed version ratings and money-weighted seller scores." },
];

export default function Home() {
  return (
    <div className="space-y-8">
      <section className="pt-4">
        <p className="section-title">Testnet marketplace · {CHAIN_NAME}</p>
        <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">Buy RL environments before you can see inside them.</h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-muted">
          Showing an environment’s tasks and hidden tests gives the product away, so buyers here judge a sealed bundle by a preview signed inside a trusted
          execution environment. Payment sits in on-chain escrow until the decryption key is delivered and a challenge window passes; specific defects can be
          disputed for bounded refunds, and every settled purchase feeds reputation.
        </p>
        <ol className="mt-6 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {FLOW.map((s, i) => (
            <li key={s.t} className="card p-3">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[11px] text-accent">{i + 1}</span>
                {s.t}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{s.d}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">
          A signature identifies who produced a report; it does not prove the report is true, and pass@1 is not proof of training value.{" "}
          <Link href="/how-it-works" className="link">
            Read the trust assumptions →
          </Link>
        </p>
      </section>

      <DeploymentGate>
        <Listings />
      </DeploymentGate>
    </div>
  );
}

function Listings() {
  const versions = useVersions();
  const events = useMarketEvents();
  const totals = useMemo(() => {
    if (!events.data) return null;
    const rows = tradeRows(events.data);
    const settledVol = rows.reduce((s, r) => s + (r.retained ?? 0n), 0n);
    const disputes = events.data.filter((e) => e.eventName === "DisputeOpened").length;
    return { purchases: rows.length, settledVol, disputes };
  }, [events.data]);

  return (
    <section className="space-y-4">
      <TeeMissingNotice />
      <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        <Stat label="Versions listed" value={versions.data ? versions.data.length : <Skeleton className="h-6 w-10" />} />
        <Stat label="Purchases" value={totals ? totals.purchases : <Skeleton className="h-6 w-10" />} />
        <Stat label="Disputes opened" value={totals ? totals.disputes : <Skeleton className="h-6 w-10" />} />
        <Stat label="Retained volume" value={totals ? fmtUsdc(totals.settledVol) : <Skeleton className="h-6 w-20" />} hint="paid to sellers after settlement" />
      </div>

      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold">Environments for sale</h2>
        <Link href="/activity" className="link text-sm">
          Live activity →
        </Link>
      </div>

      {versions.error ? (
        <Notice tone="bad" title="Could not read listings from the chain">
          {(versions.error as Error).message.split("\n")[0]}
        </Notice>
      ) : versions.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : versions.data && versions.data.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[...versions.data].reverse().map((v) => (
            <VersionCard key={v.id.toString()} v={v} />
          ))}
        </div>
      ) : (
        <Empty title="No environments listed yet">
          The contract is live but no seller has created a listing. Listings appear here as soon as a <code className="font-mono">VersionCreated</code> event is emitted.
        </Empty>
      )}
      {events.error && <p className="text-xs text-bad">Event history unavailable: {(events.error as Error).message.split("\n")[0]}</p>}
    </section>
  );
}

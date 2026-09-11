"use client";

import Link from "next/link";
import { useMemo } from "react";
import { DeploymentGate, TeeMissingNotice } from "@/components/gate";
import { ListingRowSkeleton, VersionRow } from "@/components/version-card";
import { Empty, IconArrowRight, Notice } from "@/components/ui";
import { tradeRows, useMarketEvents, useMarketParams, useVersions } from "@/lib/market";
import { fmtUsdc, pct } from "@/lib/format";

export default function Home() {
  const params = useMarketParams();
  const cap = params.data ? `up to ${pct(params.data.refundCapBps)} of the price` : "up to a fixed cap";
  const steps = [
    { t: "Check the signed preview", d: "A secure enclave (TEE) runs today’s models on the sealed tasks and signs their scores." },
    { t: "Pay into escrow", d: "The contract holds your payment. The seller is paid when your protection window ends." },
    { t: "Download and inspect", d: "Your copy is encrypted to you, checked against the listing, and decrypted in your browser." },
    { t: "Report a problem", d: `Defective tasks are refunded, ${cap}. Staked AI jurors decide disputed descriptions.` },
  ];
  return (
    <div className="space-y-16">
      <section aria-labelledby="hero-title" className="space-y-10">
        <div className="max-w-3xl space-y-4">
          <h1 id="hero-title" className="text-3xl font-semibold tracking-tight text-ink sm:text-[40px] sm:leading-[1.1]">
            Buy RL environments before you can see inside them.
          </h1>
          <p className="max-w-[62ch] text-[15px] leading-relaxed text-muted">
            A seller can’t show you the tasks and tests without giving them away. So each environment here comes with scores from reference models that ran it inside a secure enclave,
            and your payment waits in escrow until you’ve downloaded it and had time to check it.
          </p>
        </div>

        <ol aria-label="How buying works" className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.t} className="border-t border-line-strong pt-4">
              <div className="font-mono text-[11px] text-accent tabular-nums">{String(i + 1).padStart(2, "0")}</div>
              <div className="mt-2 text-sm font-medium text-ink">{s.t}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{s.d}</p>
            </li>
          ))}
        </ol>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>Scores show how today’s models do on the tasks. They don’t predict whether training on them will help your model.</span>
          <Link href="/how-it-works" className="link inline-flex items-center gap-1">
            What you’re trusting <IconArrowRight className="h-3 w-3" />
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
  const count = versions.data?.length;

  return (
    <section aria-labelledby="listings-title" className="space-y-4">
      <TeeMissingNotice />

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="listings-title" className="text-lg font-semibold text-ink">
          Environments
          {count !== undefined && count > 0 && <span className="ml-2 font-mono text-sm font-normal text-muted tabular-nums">{count}</span>}
        </h2>
        {totals && totals.purchases > 0 && (
          <p className="text-xs text-muted">
            <span className="font-mono text-ink tabular-nums">{totals.purchases}</span> purchase{totals.purchases === 1 ? "" : "s"} ·{" "}
            <span className="font-mono text-ink tabular-nums">{totals.disputes}</span> dispute{totals.disputes === 1 ? "" : "s"} ·{" "}
            <span className="font-mono text-ink tabular-nums">{fmtUsdc(totals.settledVol)}</span> paid to sellers ·{" "}
            <Link href="/activity" className="link">
              Activity
            </Link>
          </p>
        )}
      </div>

      {versions.error ? (
        <Notice tone="bad" title="Couldn’t load environments">
          {(versions.error as Error).message.split("\n")[0]} Reload the page, or check the RPC endpoint if it keeps failing.
        </Notice>
      ) : versions.isLoading ? (
        <ul className="card divide-y divide-line overflow-hidden" aria-busy="true" aria-label="Loading environments…">
          <ListingRowSkeleton />
          <ListingRowSkeleton />
        </ul>
      ) : versions.data && versions.data.length ? (
        <ul className="card divide-y divide-line overflow-hidden">
          {[...versions.data].reverse().map((v) => (
            <VersionRow key={v.id.toString()} v={v} />
          ))}
        </ul>
      ) : (
        <Empty
          title="No environments for sale yet"
          action={
            <>
              <Link href="/how-it-works" className="btn btn-sm">
                How it works
              </Link>
              <Link href="/jurors" className="btn btn-sm btn-ghost">
                Become a juror
              </Link>
            </>
          }
        >
          <p>
            The market is live. An environment shows up here once its seller’s files have been through a signed preview in the TEE, which takes a few minutes of model runs.
          </p>
          <p className="mt-2">Meanwhile you can get free test tokens from the bar at the top, or stake as a juror if your address is approved.</p>
        </Empty>
      )}
      {events.error && <p className="text-xs text-bad">Activity totals unavailable: {(events.error as Error).message.split("\n")[0]}</p>}
    </section>
  );
}

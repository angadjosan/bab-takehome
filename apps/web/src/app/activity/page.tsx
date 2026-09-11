"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { Notice, PageHeader, Skeleton, cx } from "@/components/ui";
import { deployment } from "@/lib/config";
import { useMarketEvents } from "@/lib/market";

const FILTERS: { key: string; label: string; names: string[] | null }[] = [
  { key: "all", label: "All", names: null },
  { key: "listings", label: "Listings", names: ["ListingCreated", "VersionCreated", "VersionActiveSet", "ReportAttached", "CollateralDeposited", "CollateralWithdrawn"] },
  { key: "purchases", label: "Purchases", names: ["Purchased", "Delivered", "RefundedUndelivered", "PurchaseSettled", "Rated"] },
  {
    key: "disputes",
    label: "Disputes",
    names: ["DisputeOpened", "SelectionArmed", "JurorsSelected", "VoteCommitted", "VoteRevealed", "JurorPaid", "JurorSlashed", "RoundFailed", "FallbackNoQuorum", "VerifierTimeout", "MechanicalResolved", "DisputeResolved"],
  },
  { key: "money", label: "Payouts", names: ["Credited", "Withdrawn", "TreasuryWithdrawn", "ReserveWithdrawn"] },
];

export default function ActivityPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Activity">{deployment ? <>Every event from the market contract since block {deployment.startBlock.toString()}.</> : null}</PageHeader>
      <DeploymentGate>
        <Suspense fallback={<FeedSkeleton />}>
          <Feed />
        </Suspense>
      </DeploymentGate>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="card space-y-3 p-4" aria-busy="true">
      <span className="sr-only">Loading events…</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3">
          <Skeleton className="mt-1.5 h-1.5 w-1.5 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Feed() {
  const q = useMarketEvents();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const requested = params.get("filter");
  const filter = FILTERS.some((f) => f.key === requested) ? requested! : "all";
  const [limit, setLimit] = useState(60);
  const current = FILTERS.find((x) => x.key === filter)!;
  const list = useMemo(() => {
    const all = q.data ?? [];
    return (current.names ? all.filter((e) => current.names!.includes(e.eventName)) : all).slice().reverse();
  }, [q.data, current]);

  function setFilter(key: string) {
    const sp = new URLSearchParams(params.toString());
    if (key === "all") sp.delete("filter");
    else sp.set("filter", key);
    const qs = sp.toString();
    setLimit(60);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter events" className="flex max-w-full overflow-x-auto rounded-md border border-line bg-panel p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cx(
                "h-7 cursor-pointer rounded px-3 text-[13px] whitespace-nowrap transition-colors duration-150",
                filter === f.key ? "bg-panel-2 font-medium text-ink" : "text-muted hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="font-mono text-xs text-muted tabular-nums" aria-live="polite">
          {q.data ? `${list.length} event${list.length === 1 ? "" : "s"}` : "Loading…"}
        </span>
      </div>

      {q.error ? (
        <Notice tone="bad" title="Couldn’t read events from the chain">
          {(q.error as Error).message.split("\n")[0]} Reload the page to try again.
        </Notice>
      ) : q.isLoading ? (
        <FeedSkeleton />
      ) : (
        <div className="card px-4 sm:px-5">
          <EventList events={list.slice(0, limit)} empty={filter === "all" ? "No events yet." : `No ${current.label.toLowerCase()} events yet.`} />
          {list.length > limit && (
            <div className="border-t border-line py-3">
              <button className="btn btn-sm" onClick={() => setLimit((l) => l + 100)}>
                Show more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

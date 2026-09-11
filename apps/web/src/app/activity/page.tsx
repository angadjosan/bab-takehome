"use client";

import { useMemo, useState } from "react";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { Card, Notice, Skeleton, cx } from "@/components/ui";
import { useMarketEvents } from "@/lib/market";
import { deployment } from "@/lib/config";

const FILTERS: { key: string; label: string; names: string[] | null }[] = [
  { key: "all", label: "All", names: null },
  { key: "listings", label: "Listings", names: ["ListingCreated", "VersionCreated", "VersionActiveSet", "ReportAttached", "CollateralDeposited", "CollateralWithdrawn"] },
  { key: "purchases", label: "Purchases", names: ["Purchased", "Delivered", "RefundedUndelivered", "PurchaseSettled", "Rated"] },
  { key: "disputes", label: "Disputes & jurors", names: ["DisputeOpened", "SelectionArmed", "JurorsSelected", "VoteCommitted", "VoteRevealed", "JurorPaid", "JurorSlashed", "RoundFailed", "FallbackNoQuorum", "VerifierTimeout", "MechanicalResolved", "DisputeResolved"] },
  { key: "money", label: "Payouts", names: ["Credited", "Withdrawn", "TreasuryWithdrawn", "ReserveWithdrawn"] },
];

export default function ActivityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Market activity</h1>
        <p className="mt-1 text-sm text-muted">Every EnvMarket event, read from the chain in chunked block ranges and decoded in your browser. Refreshes every 12 seconds.</p>
      </div>
      <DeploymentGate>
        <Feed />
      </DeploymentGate>
    </div>
  );
}

function Feed() {
  const q = useMarketEvents();
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(60);
  const list = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const all = q.data ?? [];
    return (f.names ? all.filter((e) => f.names!.includes(e.eventName)) : all).slice().reverse();
  }, [q.data, filter]);

  return (
    <Card
      title={q.data ? `${list.length} event${list.length === 1 ? "" : "s"}` : "Loading events…"}
      subtitle={deployment ? `From block ${deployment.startBlock.toString()}` : undefined}
      action={
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f.key} className={cx("rounded-md px-2.5 py-1 text-xs", filter === f.key ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-panel-2")} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {q.error ? (
        <Notice tone="bad" title="Could not read events">
          {(q.error as Error).message.split("\n")[0]}
        </Notice>
      ) : q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <>
          <EventList events={list.slice(0, limit)} empty="Nothing here yet." />
          {list.length > limit && (
            <button className="btn btn-sm mt-3" onClick={() => setLimit((l) => l + 100)}>
              Show more
            </button>
          )}
        </>
      )}
    </Card>
  );
}

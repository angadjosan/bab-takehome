"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { AddressLink, Card, Empty, Notice, Skeleton, Stars, Stat, cx } from "@/components/ui";
import { fmtUsdc } from "@/lib/format";
import {
  QUALIFY_THRESHOLD,
  concentration,
  readOptional,
  tradeRows,
  useMarketEvents,
  useSellerScore,
  useSellerStake,
  useSellerStats,
  type TradeRow,
} from "@/lib/market";
import { ClaimBanner } from "../../purchase/[id]/purchase-view";

export function SellerView({ address }: { address: string }) {
  if (!isAddress(address)) return <Empty title="Not an address">“{address}” is not a valid Ethereum address.</Empty>;
  return (
    <DeploymentGate>
      <Body a={getAddress(address)} />
    </DeploymentGate>
  );
}

function Body({ a }: { a: Address }) {
  const { address: me } = useAccount();
  const stake = useSellerStake(a);
  const score = useSellerScore(a);
  const stats = useSellerStats(a);
  const events = useMarketEvents();
  const rows = useMemo(() => (events.data ? tradeRows(events.data) : []), [events.data]);
  const sales = rows.filter((r) => r.seller?.toLowerCase() === a.toLowerCase());
  const buys = rows.filter((r) => r.buyer?.toLowerCase() === a.toLowerCase());
  const conc = useMemo(() => concentration(rows, a), [rows, a]);
  const versions = useQuery({
    queryKey: ["seller-versions", a],
    queryFn: async () => ((await readOptional("listVersionIdsBySeller", [a])) as bigint[] | undefined) ?? [],
  });
  const involved = useMemo(() => {
    if (!events.data) return [];
    const pids = new Set([...sales, ...buys].map((r) => r.purchaseId.toString()));
    const lc = a.toLowerCase();
    return events.data
      .filter((e) => (e.args.purchaseId !== undefined && pids.has(String(e.args.purchaseId))) || Object.values(e.args).some((v) => typeof v === "string" && v.toLowerCase() === lc))
      .slice(-40)
      .reverse();
  }, [events.data, sales, buys, a]);

  const isMe = me?.toLowerCase() === a.toLowerCase();
  const s = score.data;
  const n = Number(s?.qualifyingTx ?? 0n);
  const rating = s && s.ratedRetained > 0n ? Number((s.weightedRatingSum * 1000n) / s.ratedRetained) / 1000 : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="section-title">Account</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="break-all font-mono text-xl font-semibold">{a}</h1>
          {isMe && <span className="badge badge-accent">you</span>}
        </div>
        <div className="mt-1 text-sm">
          <AddressLink address={a} />
        </div>
      </div>

      {isMe && <ClaimBanner />}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Seller reputation" subtitle="Belongs to this wallet. Money-weighted, from settled purchases only." className="lg:col-span-2">
          {!s || !stats.data ? (
            <Skeleton className="h-28" />
          ) : (
            <div className="space-y-5">
              <div>
                {s.eligible ? (
                  rating !== null ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Stars value={rating} size="text-2xl" />
                      <span className="text-2xl font-semibold">{rating.toFixed(2)}</span>
                      <span className="text-sm text-muted">money-weighted over {fmtUsdc(s.ratedRetained)} of rated retained payments</span>
                    </div>
                  ) : (
                    <div className="text-lg font-semibold">Eligible seller — no purchaser ratings yet</div>
                  )
                ) : (
                  <div className="text-lg font-semibold text-warn">
                    New seller — {n}/{QUALIFY_THRESHOLD.toString()} transactions
                  </div>
                )}
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-panel-2">
                  <div className="h-2 rounded-full bg-accent" style={{ width: `${Math.min(100, n)}%` }} />
                </div>
                <p className="mt-2 text-xs text-muted">
                  A qualifying transaction is funded, delivered, settled, and leaves the seller a positive retained payment. The seller score appears after 100 of them:{" "}
                  <span className="font-mono">Σ(retained × stars) / Σ(retained for rated purchases)</span>. Until then only the count and stake are shown. Unrated purchases add no positive feedback.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Qualifying tx" value={n} />
                <Stat label="Retained volume" value={fmtUsdc(stats.data.retainedVolume)} />
                <Stat label="Disputes" value={`${stats.data.disputesOpened} / ${stats.data.disputesUpheld}`} hint="opened / upheld" />
                <Stat label="Full refunds" value={stats.data.fullRefunds} hint="stay visible in history" />
              </div>
            </div>
          )}
        </Card>

        <Card title="Seller stake" subtitle="Collateral backing sales. A bigger stake secures more concurrent sales; it is not a quality score.">
          {!stake.data ? (
            <Skeleton className="h-28" />
          ) : (
            <div className="space-y-3">
              <Stat label="Total" value={fmtUsdc(stake.data.total)} />
              <div className="h-2 w-full overflow-hidden rounded-full bg-panel-2">
                <div className="h-2 bg-warn" style={{ width: stake.data.total > 0n ? `${Number((stake.data.reserved * 100n) / stake.data.total)}%` : "0%" }} />
              </div>
              <div className="flex justify-between text-xs">
                <span>
                  <span className="text-warn">■</span> reserved {fmtUsdc(stake.data.reserved)}
                </span>
                <span className="text-muted">available {fmtUsdc(stake.data.available)}</span>
              </div>
              <p className="text-xs text-muted">Reserved collateral backs exactly one active purchase and can’t back another.</p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Counterparty concentration" subtitle="Computed in your browser from Purchased and PurchaseSettled events since the deployment block.">
        {events.isLoading ? (
          <Skeleton className="h-20" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Distinct buyers" value={conc.distinct} hint="with positive retained payment" />
              <Stat label="Largest buyer share" value={conc.distinct ? `${conc.largestShare.toFixed(1)}%` : "—"} hint="of retained volume" />
              <Stat label="Retained (events)" value={fmtUsdc(conc.totalRetained)} />
            </div>
            {conc.counterparties.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1.5 font-medium">Buyer</th>
                    <th className="py-1.5 font-medium">Purchases</th>
                    <th className="py-1.5 text-right font-medium">Retained</th>
                  </tr>
                </thead>
                <tbody>
                  {conc.counterparties.map((c) => (
                    <tr key={c.buyer} className="border-t border-line">
                      <td className="py-1.5">
                        <AddressLink address={c.buyer} seller />
                      </td>
                      <td className="py-1.5">{c.count}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtUsdc(c.volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-muted">These checks cannot prove different wallets have different owners; circular trading between related wallets remains possible.</p>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Sales" subtitle={versions.data?.length ? `${versions.data.length} version(s) listed` : undefined}>
          {versions.data && versions.data.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {versions.data.map((v) => (
                <Link key={v.toString()} href={`/listing/${v}`} className="badge badge-accent">
                  version #{v.toString()}
                </Link>
              ))}
            </div>
          )}
          <Trades rows={sales} role="seller" />
        </Card>
        <Card title="Purchases" subtitle={isMe ? "Your purchases as a buyer." : undefined}>
          <Trades rows={buys} role="buyer" />
        </Card>
      </div>

      <Card title="Recent activity involving this account">{events.isLoading ? <Skeleton className="h-24" /> : <EventList events={involved} empty="No activity yet." />}</Card>

      {events.error && <Notice tone="bad">Event history unavailable: {(events.error as Error).message.split("\n")[0]}</Notice>}
    </div>
  );
}

function Trades({ rows, role }: { rows: TradeRow[]; role: "buyer" | "seller" }) {
  if (!rows.length) return <p className="text-sm text-muted">None yet.</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {[...rows].reverse().map((r) => {
        const status = r.fullRefund ? "full refund" : r.settled ? "settled" : r.disputed ? "disputed" : "open";
        return (
          <li key={r.purchaseId.toString()} className="flex items-center justify-between gap-3 py-2">
            <Link href={`/purchase/${r.purchaseId}`} className="link">
              Purchase #{r.purchaseId.toString()}
            </Link>
            <span className="text-xs text-muted">
              version #{r.versionId.toString()} · {role === "seller" ? "buyer" : "seller"} {role === "seller" ? r.buyer?.slice(0, 6) : r.seller?.slice(0, 6)}…
            </span>
            <span className="flex items-center gap-2">
              {r.stars ? <span className="text-xs text-warn">{"★".repeat(r.stars)}</span> : null}
              <span className={cx("badge", r.fullRefund ? "badge-warn" : r.settled ? "badge-ok" : r.disputed ? "badge-warn" : "badge-info")}>{status}</span>
              <span className="tabular-nums">{fmtUsdc(r.price)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

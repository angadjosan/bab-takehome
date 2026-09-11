"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { DepositAction, WithdrawAction } from "@/components/token-action";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import { AddressLink, Card, Countdown, Empty, Notice, Skeleton, Stars, Stat, cx, useNow } from "@/components/ui";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { eqHash } from "@/lib/crypto";
import { fmtTime, fmtUsdc } from "@/lib/format";
import {
  QUALIFY_THRESHOLD,
  concentration,
  isZeroHash,
  readOptional,
  tradeRows,
  useMarketEvents,
  usePreviewInfo,
  usePurchase,
  useSellerScore,
  useSellerStake,
  useSellerStats,
  useVersion,
  type TradeRow,
} from "@/lib/market";
import { getPreviewQuote, startPreview, type PreviewQuote } from "@/lib/tee";
import { useHealth } from "@/lib/docs";
import { ClaimBanner, StateBadge } from "../../purchase/[id]/purchase-view";

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
    refetchInterval: 15_000,
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
  const open = sales.filter((r) => !r.settled && !r.fullRefund);

  return (
    <div className="space-y-6">
      <div>
        <p className="section-title">{isMe ? "Your seller dashboard" : "Account"}</p>
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
              {isMe && (
                <div className="space-y-4 border-t border-line pt-4">
                  <div>
                    <div className="section-title mb-1">Deposit collateral</div>
                    <DepositAction label="Deposit" functionName="depositCollateral" />
                  </div>
                  <div>
                    <div className="section-title mb-1">Withdraw available collateral</div>
                    <WithdrawAction label="Withdraw" functionName="withdrawCollateral" max={stake.data.available} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {open.length > 0 && (
        <Card title="Open sales" subtitle="Anyone can move these along: finalize after the challenge window, or refund a purchase the relay never delivered.">
          <ul className="divide-y divide-line">
            {[...open].reverse().map((r) => (
              <KeeperRow key={r.purchaseId.toString()} id={r.purchaseId} />
            ))}
          </ul>
        </Card>
      )}

      <Card title="Versions" subtitle={isMe ? "Your listed versions: report status and the seller-paid preview." : "Versions listed by this seller."}>
        {versions.isLoading ? (
          <Skeleton className="h-16" />
        ) : !versions.data?.length ? (
          <p className="text-sm text-muted">No versions listed.</p>
        ) : (
          <ul className="divide-y divide-line">
            {[...versions.data].reverse().map((id) => (
              <VersionRow key={id.toString()} id={id} isMe={isMe} />
            ))}
          </ul>
        )}
      </Card>

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
        <Card title="Sales">
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

/* -------------------------- permissionless keeper actions -------------------------- */

function KeeperRow({ id }: { id: bigint }) {
  const q = usePurchase(id);
  const now = useNow();
  const tx = useTx();
  const p = q.data;
  if (!p) return <li className="py-2 text-sm text-muted">Purchase #{id.toString()}…</li>;
  const canFinalize = p.state === "Delivered" && now > p.challengeDeadline && p.disputeId === 0n;
  const canRefund = p.state === "Funded" && now > p.deliveryDeadline;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
      <Link href={`/purchase/${p.id}`} className="link">
        Purchase #{p.id.toString()}
      </Link>
      <StateBadge state={p.state} />
      <span className="text-xs text-muted">
        {p.state === "Funded" && (canRefund ? "delivery deadline passed" : <>delivery due in <Countdown to={p.deliveryDeadline} /></>)}
        {p.state === "Delivered" && (canFinalize ? "challenge window closed" : <>challenge window: <Countdown to={p.challengeDeadline} /></>)}
        {p.state === "Disputed" && (
          <Link href={`/dispute/${p.disputeId}`} className="link">
            dispute #{p.disputeId.toString()}
          </Link>
        )}
      </span>
      <span className="ml-auto">
        {canFinalize && (
          <button className="btn btn-primary btn-sm" disabled={tx.busy} onClick={() => tx.run("Finalize", { address: deployment!.market, abi: marketAbi, functionName: "finalize", args: [p.id] })}>
            Finalize
          </button>
        )}
        {canRefund && (
          <button className="btn btn-sm" disabled={tx.busy} onClick={() => tx.run("Refund", { address: deployment!.market, abi: marketAbi, functionName: "refundUndelivered", args: [p.id] })}>
            Refund undelivered
          </button>
        )}
      </span>
      {tx.state.status !== "idle" && (
        <div className="w-full">
          <TxStatus state={tx.state} />
        </div>
      )}
    </li>
  );
}

/* ------------------------------ versions + previews ------------------------------ */

function VersionRow({ id, isMe }: { id: bigint; isMe: boolean }) {
  const v = useVersion(id);
  const pi = usePreviewInfo(id);
  const now = useNow();
  if (!v.data) return <li className="py-2 text-sm text-muted">Version #{id.toString()}…</li>;
  const hasReport = !isZeroHash(v.data.reportHash);
  const info = pi.data;
  const paid = !!info && info.paidAt > 0 && !info.reclaimed;
  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/listing/${id}`} className="link font-medium">
          Version #{id.toString()}
        </Link>
        <span className="text-xs text-muted">
          listing #{v.data.listingId.toString()} v{v.data.versionNo} · {fmtUsdc(v.data.price)} · collateral {fmtUsdc(v.data.collateral)}
        </span>
        {!v.data.active && <span className="badge badge-warn">inactive</span>}
        {hasReport ? <span className="badge badge-ok">report attached</span> : paid ? <span className="badge badge-info">preview paid, no report yet</span> : <span className="badge badge-neutral">no preview</span>}
        {info && info.paidAt > 0 && (
          <span className="text-xs text-muted">
            fee {fmtUsdc(info.fee)} {info.released ? "released" : info.reclaimed ? "reclaimed" : "escrowed"}
          </span>
        )}
      </div>
      {isMe && !hasReport && info !== null && info !== undefined && (
        <PreviewActions versionId={id} paid={paid} reclaimable={paid && !info.released && now > info.deadline} deadline={info.deadline} />
      )}
    </li>
  );
}

function PreviewActions({ versionId, paid, reclaimable, deadline }: { versionId: bigint; paid: boolean; reclaimable: boolean; deadline: number }) {
  const { address } = useAccount();
  const health = useHealth();
  const [quote, setQuote] = useState<PreviewQuote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const approve = useTx();
  const request = useTx();
  const reclaim = useTx();
  const m = deployment!.market;
  const fee = quote ? BigInt(quote.quote.feeUsdc) : null;
  const allowance = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "allowance", args: [address!, m], query: { enabled: !!address && fee !== null, refetchInterval: 5_000 } });
  const approved = fee !== null && ((allowance.data as bigint | undefined) ?? 0n) >= fee;
  const now = useNow();
  const quoteTrusted = !!quote && quote.hashOk && !!quote.signer && eqHash(quote.signer, health.data?.signer) && now < quote.quote.validUntil;

  async function runPreview() {
    setErr(null);
    try {
      const r = await startPreview(versionId);
      setRunMsg(r === "running" ? "The TEE started the preview run (minutes). The report is attached on-chain when it finishes." : "The TEE already has a report for this version; it is being attached.");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <RequireWallet>
      <div className="space-y-2 rounded-lg bg-panel-2 p-3 text-xs">
        {!paid ? (
          <>
            <p className="text-muted">Request a preview: the TEE quotes the inference cost, you pay it into escrow with requestPreview, then the TEE runs the reference panel and validator.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn btn-sm"
                onClick={async () => {
                  setErr(null);
                  try {
                    setQuote(await getPreviewQuote(versionId));
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                {quote ? "Refresh quote" : "Get quote"}
              </button>
              {quote && fee !== null && (
                <>
                  <span>
                    fee <span className="font-semibold">{fmtUsdc(fee)}</span> (est. ${quote.quote.estimatedCostUsd} for {quote.quote.episodes} episodes{quote.quote.cached ? ", cached run" : ""}) · valid until {fmtTime(quote.quote.validUntil)}
                  </span>
                  <span className={cx("badge", quoteTrusted ? "badge-ok" : "badge-bad")}>{quoteTrusted ? "signed by the TEE" : "quote not verified"}</span>
                  {!approved ? (
                    <button className="btn btn-sm" disabled={!quoteTrusted || approve.busy} onClick={() => approve.run("Approve fee", { address: deployment!.token, abi: tokenAbi, functionName: "approve", args: [m, fee] })}>
                      Approve {fmtUsdc(fee)}
                    </button>
                  ) : (
                    <span className="badge badge-ok">approved</span>
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!quoteTrusted || !approved || request.busy}
                    onClick={async () => {
                      if (await request.run("Request preview", { address: m, abi: marketAbi, functionName: "requestPreview", args: [versionId, fee, quote.quoteHash] })) await runPreview();
                    }}
                  >
                    Pay & request preview
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Preview paid. If the run did not start (or the TEE restarted), start it again; it is cached once finished.</span>
            <button className="btn btn-sm" onClick={runPreview}>
              Start preview run
            </button>
            {reclaimable ? (
              <button className="btn btn-sm" disabled={reclaim.busy} onClick={() => reclaim.run("Reclaim fee", { address: m, abi: marketAbi, functionName: "reclaimPreviewFee", args: [versionId] })}>
                Reclaim preview fee
              </button>
            ) : (
              <span className="text-muted">
                reclaimable if no report by {fmtTime(deadline)} (<Countdown to={deadline} />)
              </span>
            )}
          </div>
        )}
        {runMsg && <p className="text-ok">{runMsg}</p>}
        {err && <p className="break-words text-bad">{err}</p>}
        <TxStatus state={approve.state} />
        <TxStatus state={request.state} />
        <TxStatus state={reclaim.state} />
      </div>
    </RequireWallet>
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

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { DepositAction, WithdrawAction } from "@/components/token-action";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import { useApproveAndCall } from "@/components/tx-sequence";
import { AddressLink, Card, Chip, Countdown, DetailSection, Details, Empty, Notice, PageHeader, Skeleton, Spinner, Stars, Stat, useNow, type Tone } from "@/components/ui";
import { marketAbi } from "@/lib/abi";
import { deployment } from "@/lib/config";
import { eqHash } from "@/lib/crypto";
import { fmtTime, fmtUsdc, shortAddr } from "@/lib/format";
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
  if (!isAddress(address))
    return (
      <Empty title="That isn’t a valid address">
        <span className="font-mono [overflow-wrap:anywhere]">“{address}”</span> should be 0x followed by 40 hex characters.
      </Empty>
    );
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
  const hasVersions = !!versions.data?.length;

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={isMe ? undefined : "Seller"}
        title={
          isMe ? (
            "Your account"
          ) : (
            <span className="font-mono" translate="no" title={a}>
              {shortAddr(a)}
            </span>
          )
        }
        meta={
          isMe ? (
            <span className="font-mono" translate="no" title={a}>
              {shortAddr(a)}
            </span>
          ) : undefined
        }
      >
        {isMe ? "Your sales, purchases, stake and listings in one place." : "What this seller has sold, how buyers rated it, and how much stake backs its sales."}
      </PageHeader>

      {isMe && <ClaimBanner />}

      {open.length > 0 && (
        <section aria-labelledby="action-title" className="space-y-3">
          <h2 id="action-title" className="text-sm font-semibold text-ink">
            Open sales
          </h2>
          <p className="text-xs text-muted">Anyone can move these along: release payment once the buyer’s protection window ends, or refund a buyer whose key never arrived.</p>
          <ul className="card divide-y divide-line">
            {[...open].reverse().map((r) => (
              <KeeperRow key={r.purchaseId.toString()} id={r.purchaseId} />
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Reputation" subtitle="From completed sales only, and tied to this wallet.">
          {!s || !stats.data ? (
            <Skeleton className="h-32" />
          ) : (
            <div className="space-y-6">
              <div className="space-y-3">
                {s.eligible ? (
                  rating !== null ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Stars value={rating} size="text-xl" />
                      <span className="font-mono text-xl font-medium text-ink tabular-nums">{rating.toFixed(2)}</span>
                      <span className="text-[13px] text-muted">weighted by what each buyer paid</span>
                    </div>
                  ) : (
                    <div className="text-base font-medium text-ink">No buyer ratings yet</div>
                  )
                ) : (
                  <div className="text-base font-medium text-ink">
                    New seller · <span className="font-mono tabular-nums">{n}</span> of {QUALIFY_THRESHOLD.toString()} sales
                  </div>
                )}
                {!s.eligible && (
                  <div
                    role="progressbar"
                    aria-label="Completed sales toward a seller score"
                    aria-valuemin={0}
                    aria-valuemax={Number(QUALIFY_THRESHOLD)}
                    aria-valuenow={n}
                    className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-panel-2"
                  >
                    <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.min(100, n)}%` }} />
                  </div>
                )}
                <p className="max-w-[70ch] text-xs leading-relaxed text-muted">
                  A sale counts once it’s delivered, completed and leaves the seller paid. The seller score appears after 100 of them: the average star rating, weighted by what each buyer
                  paid. Unrated sales add nothing.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <Stat label="Completed sales" value={n} />
                <Stat label="Paid to seller" value={fmtUsdc(stats.data.retainedVolume, { symbol: false })} />
                <Stat label="Problems reported" value={stats.data.disputesOpened} hint={`${stats.data.disputesUpheld} upheld`} />
                <Stat label="Full refunds" value={stats.data.fullRefunds} />
              </div>
            </div>
          )}
        </Card>

        <Card title="Stake" subtitle="Collateral that backs open sales. More stake allows more sales at once; it isn’t a quality score.">
          {!stake.data ? (
            <Skeleton className="h-28" />
          ) : (
            <div className="space-y-4">
              <Stat label="Total" value={fmtUsdc(stake.data.total)} />
              <div>
                <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                  <div className="h-1.5 rounded-full bg-warn" style={{ width: stake.data.total > 0n ? `${Number((stake.data.reserved * 100n) / stake.data.total)}%` : "0%" }} />
                </div>
                <div className="mt-2 flex justify-between gap-3 text-xs text-muted">
                  <span>
                    <span className="font-mono text-ink tabular-nums">{fmtUsdc(stake.data.reserved, { symbol: false })}</span> backing open sales
                  </span>
                  <span>
                    <span className="font-mono text-ink tabular-nums">{fmtUsdc(stake.data.available, { symbol: false })}</span> free
                  </span>
                </div>
              </div>
              {isMe && (
                <div className="space-y-5 border-t border-line pt-4">
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-ink">Add stake</div>
                    <DepositAction label="Deposit" functionName="depositCollateral" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-ink">Withdraw free stake</div>
                    <WithdrawAction label="Withdraw" functionName="withdrawCollateral" max={stake.data.available} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {(hasVersions || isMe) && (
        <section aria-labelledby="listings-title" className="space-y-3">
          <h2 id="listings-title" className="text-sm font-semibold text-ink">
            {isMe ? "Your listings" : "Listings"}
          </h2>
          {versions.isLoading ? (
            <Skeleton className="h-16" />
          ) : !hasVersions ? (
            <p className="text-sm text-muted">No environments listed yet. Listings are created with the seller agent (see the repository README).</p>
          ) : (
            <ul className="card divide-y divide-line">
              {[...versions.data!].reverse().map((id) => (
                <VersionRow key={id.toString()} id={id} isMe={isMe} />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="sales-title" className="min-w-0 space-y-3">
          <h2 id="sales-title" className="text-sm font-semibold text-ink">
            Sales <span className="ml-1 font-mono font-normal text-muted tabular-nums">{sales.length}</span>
          </h2>
          {events.isLoading ? <Skeleton className="h-24" /> : <Trades rows={sales} empty="No sales yet." />}
        </section>
        <section aria-labelledby="buys-title" className="min-w-0 space-y-3">
          <h2 id="buys-title" className="text-sm font-semibold text-ink">
            {isMe ? "Your purchases" : "Purchases"} <span className="ml-1 font-mono font-normal text-muted tabular-nums">{buys.length}</span>
          </h2>
          {events.isLoading ? <Skeleton className="h-24" /> : <Trades rows={buys} empty="No purchases yet." />}
        </section>
      </div>

      {events.error && (
        <Notice tone="bad" title="Couldn’t load sales and purchases">
          {(events.error as Error).message.split("\n")[0]} Reload the page to try again.
        </Notice>
      )}

      <Details summary="Details: full address, who this seller sells to, and raw activity">
        <DetailSection title="Address">
          <AddressLink address={a} />
          <p className="mt-1 font-mono text-xs text-muted [overflow-wrap:anywhere]" translate="no">
            {a}
          </p>
        </DetailSection>
        <DetailSection title="Who buys from this seller" hint="Worked out in your browser from purchase and settlement events since the deployment block. It can’t prove that different wallets have different owners, so trading between related wallets is still possible.">
          {events.isLoading ? (
            <Skeleton className="h-20" />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                <Stat label="Distinct buyers" value={conc.distinct} hint="who left the seller paid" />
                <Stat label="Largest buyer share" value={conc.distinct ? `${conc.largestShare.toFixed(1)}%` : "—"} hint="of what the seller was paid" />
                <Stat label="Paid to seller" value={fmtUsdc(conc.totalRetained, { symbol: false })} hint="from events" />
              </div>
              {conc.counterparties.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="data-table min-w-[420px]">
                    <thead>
                      <tr>
                        <th scope="col">Buyer</th>
                        <th scope="col" className="text-right">
                          Purchases
                        </th>
                        <th scope="col" className="text-right">
                          Paid to seller
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {conc.counterparties.map((c) => (
                        <tr key={c.buyer}>
                          <td>
                            <AddressLink address={c.buyer} seller />
                          </td>
                          <td className="text-right font-mono">{c.count}</td>
                          <td className="text-right font-mono">{fmtUsdc(c.volume, { symbol: false })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </DetailSection>
        <DetailSection title="Recent activity">{events.isLoading ? <Skeleton className="h-24" /> : <EventList events={involved} empty="No activity yet." />}</DetailSection>
      </Details>
    </div>
  );
}

/* -------------------------- permissionless keeper actions -------------------------- */

function KeeperRow({ id }: { id: bigint }) {
  const q = usePurchase(id);
  const now = useNow();
  const tx = useTx();
  const p = q.data;
  if (!p)
    return (
      <li className="flex items-center gap-2 px-4 py-3 text-sm text-muted sm:px-5">
        <Spinner className="h-3.5 w-3.5" /> Loading purchase #{id.toString()}…
      </li>
    );
  const canFinalize = p.state === "Delivered" && now > p.challengeDeadline && p.disputeId === 0n;
  const canRefund = p.state === "Funded" && now > p.deliveryDeadline;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-5">
      <Link href={`/purchase/${p.id}`} className="link">
        Purchase #{p.id.toString()}
      </Link>
      <StateBadge state={p.state} />
      <span className="text-xs text-muted tabular-nums">
        {p.state === "Funded" &&
          (canRefund ? (
            "Key wasn’t delivered in time"
          ) : (
            <>
              Key due in <Countdown to={p.deliveryDeadline} />
            </>
          ))}
        {p.state === "Delivered" &&
          (canFinalize ? (
            "Protection window over"
          ) : (
            <>
              Buyer can report problems for <Countdown to={p.challengeDeadline} />
            </>
          ))}
        {p.state === "Disputed" && (
          <Link href={`/dispute/${p.disputeId}`} className="link">
            Dispute #{p.disputeId.toString()}
          </Link>
        )}
      </span>
      <span className="ml-auto">
        {canFinalize && (
          <button className="btn btn-primary btn-sm" disabled={tx.busy} onClick={() => tx.run("Release payment", { address: deployment!.market, abi: marketAbi, functionName: "finalize", args: [p.id] })}>
            {tx.busy ? "Releasing…" : "Release payment"}
          </button>
        )}
        {canRefund && (
          <button className="btn btn-sm" disabled={tx.busy} onClick={() => tx.run("Refund buyer", { address: deployment!.market, abi: marketAbi, functionName: "refundUndelivered", args: [p.id] })}>
            {tx.busy ? "Refunding…" : "Refund buyer"}
          </button>
        )}
      </span>
      {tx.state.status !== "idle" && (
        <div className="w-full" aria-live="polite">
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
  if (!v.data)
    return (
      <li className="flex items-center gap-2 px-4 py-3 text-sm text-muted sm:px-5">
        <Spinner className="h-3.5 w-3.5" /> Loading environment #{id.toString()}…
      </li>
    );
  const hasReport = !isZeroHash(v.data.reportHash);
  const info = pi.data;
  const paid = !!info && info.paidAt > 0 && !info.reclaimed;
  return (
    <li className="space-y-3 px-4 py-3.5 text-sm sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={`/listing/${id}`} className="link font-medium">
          Environment #{id.toString()}
        </Link>
        <span className="text-xs text-muted">
          Listing #{v.data.listingId.toString()}, version {v.data.versionNo} · <span className="font-mono tabular-nums">{fmtUsdc(v.data.price)}</span>
        </span>
        <span className="flex flex-wrap gap-1.5 sm:ml-auto">
          {!v.data.active && <Chip tone="warn">Not for sale</Chip>}
          {hasReport ? <Chip tone="ok">Verified preview</Chip> : paid ? <Chip tone="info">Preview running</Chip> : <Chip>No preview yet</Chip>}
        </span>
      </div>
      {info && info.paidAt > 0 && (
        <p className="text-xs text-muted">
          Preview fee <span className="font-mono tabular-nums">{fmtUsdc(info.fee)}</span>{" "}
          {info.released ? "paid to the TEE operator" : info.reclaimed ? "returned to the seller" : "held until the report is published"}
        </p>
      )}
      {isMe && !hasReport && info !== null && info !== undefined && (
        <PreviewActions versionId={id} paid={paid} reclaimable={paid && !info.released && now > info.deadline} deadline={info.deadline} />
      )}
    </li>
  );
}

function PreviewActions({ versionId, paid, reclaimable, deadline }: { versionId: bigint; paid: boolean; reclaimable: boolean; deadline: number }) {
  const health = useHealth();
  const [quote, setQuote] = useState<PreviewQuote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const request = useApproveAndCall();
  const reclaim = useTx();
  const m = deployment!.market;
  const fee = quote ? BigInt(quote.quote.feeUsdc) : null;
  const now = useNow();
  const quoteTrusted = !!quote && quote.hashOk && !!quote.signer && eqHash(quote.signer, health.data?.signer) && now < quote.quote.validUntil;

  async function runPreview() {
    setErr(null);
    try {
      const r = await startPreview(versionId);
      setRunMsg(r === "running" ? "The preview is running. It takes a few minutes; the report is published on-chain when it finishes." : "The TEE already has a report for this environment and is publishing it.");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <RequireWallet>
      <div className="space-y-3 rounded-md bg-panel-2 p-3.5 text-[13px]">
        {!paid ? (
          <>
            <p className="text-muted">Get a signed preview. The TEE quotes the model cost, you pay it, and it runs the reference models on your environment. Buyers can’t purchase until it’s done.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={quote ? "btn btn-sm" : "btn btn-primary btn-sm"}
                disabled={quoting}
                onClick={async () => {
                  setErr(null);
                  setQuoting(true);
                  try {
                    setQuote(await getPreviewQuote(versionId));
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setQuoting(false);
                  }
                }}
              >
                {quoting ? "Getting quote…" : quote ? "Refresh quote" : "Get a quote"}
              </button>
              {quote && fee !== null && (
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!quoteTrusted || request.busy}
                  onClick={async () => {
                    if (await request.run("Pay preview fee", fee, { address: m, abi: marketAbi, functionName: "requestPreview", args: [versionId, fee, quote.quoteHash] })) await runPreview();
                  }}
                >
                  {request.busy ? "Paying…" : `Pay ${fmtUsdc(fee)} and start preview`}
                </button>
              )}
            </div>
            {quote && fee !== null && (
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>
                  {quote.quote.episodes} model runs, estimated ${quote.quote.estimatedCostUsd}
                  {quote.quote.cached ? ", from a cached run" : ""}. Quote valid until {fmtTime(quote.quote.validUntil)}.
                </span>
                <Chip tone={quoteTrusted ? "ok" : "bad"}>{quoteTrusted ? "Quote signed by the TEE" : "Quote not verified"}</Chip>
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Preview paid. If it didn’t start, or the TEE restarted, start it again. A finished run is cached.</span>
            <button className="btn btn-sm" onClick={runPreview}>
              Start preview
            </button>
            {reclaimable ? (
              <button className="btn btn-sm" disabled={reclaim.busy} onClick={() => reclaim.run("Get the fee back", { address: m, abi: marketAbi, functionName: "reclaimPreviewFee", args: [versionId] })}>
                {reclaim.busy ? "Returning fee…" : "Get the fee back"}
              </button>
            ) : (
              <span className="text-xs text-muted">
                You can get the fee back if there’s no report by {fmtTime(deadline)} (<Countdown to={deadline} />).
              </span>
            )}
          </div>
        )}
        <div aria-live="polite" className="space-y-1">
          {runMsg && <p className="text-ok">{runMsg}</p>}
          {err && (
            <p role="alert" className="text-bad [overflow-wrap:anywhere]">
              {err}
            </p>
          )}
          <TxStatus state={request.state} />
          <TxStatus state={reclaim.state} />
        </div>
      </div>
    </RequireWallet>
  );
}

const TRADE_STATUS = (r: TradeRow): { text: string; tone: Tone } =>
  r.fullRefund ? { text: "Refunded", tone: "neutral" } : r.settled ? { text: "Complete", tone: "ok" } : r.disputed ? { text: "Disputed", tone: "warn" } : { text: "In progress", tone: "info" };

function Trades({ rows, empty }: { rows: TradeRow[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="card divide-y divide-line">
      {[...rows].reverse().map((r) => {
        const st = TRADE_STATUS(r);
        return (
          <li key={r.purchaseId.toString()}>
            <Link href={`/purchase/${r.purchaseId}`} className="group flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-150 hover:bg-panel-2">
              <span className="min-w-0">
                <span className="text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-[3px]">Purchase #{r.purchaseId.toString()}</span>
                <span className="ml-2 text-xs text-muted">Environment #{r.versionId.toString()}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {r.stars ? <Stars value={r.stars} size="text-xs" /> : null}
                <Chip tone={st.tone} dot>
                  {st.text}
                </Chip>
                <span className="font-mono text-ink tabular-nums">{fmtUsdc(r.price, { symbol: false })}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

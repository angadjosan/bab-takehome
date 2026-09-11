"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccount } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { DepositAction, WithdrawAction } from "@/components/token-action";
import { RequireWallet } from "@/components/tx";
import { AddressLink, Card, Notice, Skeleton, Stat, cx } from "@/components/ui";
import { fmtUsdc, pct } from "@/lib/format";
import { fetchJurorInfo, fetchJurors, useMarketEvents, useMarketParams, type JurorInfo } from "@/lib/market";
import { ClaimBanner } from "../purchase/[id]/purchase-view";

export function JurorsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Jurors</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          “Description is false” disputes go to three jurors drawn at random from this approved, staked pool (buyer and seller excluded). Each seat locks stake; revealing jurors are paid from the case fee,
          the minority and non-revealers are slashed. The owner approves juror addresses; anyone approved can stake.
        </p>
      </div>
      <DeploymentGate>
        <Body />
      </DeploymentGate>
    </div>
  );
}

function Body() {
  const { address } = useAccount();
  const params = useMarketParams();
  const jurors = useQuery({ queryKey: ["jurors"], queryFn: fetchJurors, refetchInterval: 10_000 });
  const me = useQuery({ queryKey: ["juror", address], queryFn: () => fetchJurorInfo(address!), enabled: !!address, refetchInterval: 6_000 });
  const events = useMarketEvents();
  const seatStake = params.data?.jurorStake;
  const mySeats = useMemo(() => {
    if (!address || !events.data) return [];
    const lc = address.toLowerCase();
    return events.data
      .filter((e) => e.eventName === "JurorsSelected" && Array.isArray(e.args.jurors) && (e.args.jurors as string[]).some((j) => j.toLowerCase() === lc))
      .map((e) => ({ disputeId: String(e.args.disputeId), round: Number(e.args.round) }))
      .reverse();
  }, [address, events.data]);

  const totals = (jurors.data ?? []).reduce((a, j) => ({ total: a.total + j.total, locked: a.locked + j.locked, eligible: a.eligible + (j.approved && seatStake !== undefined && j.free >= seatStake ? 1 : 0) }), {
    total: 0n,
    locked: 0n,
    eligible: 0,
  });

  return (
    <>
      <ClaimBanner />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Juror pool" subtitle="From jurorList() and jurorInfo(); eligibility is free stake ≥ the per-seat stake (a deposit made after a draw’s selection block sits out that draw).">
          {jurors.isLoading ? (
            <Skeleton className="h-40" />
          ) : jurors.error ? (
            <Notice tone="bad">{(jurors.error as Error).message}</Notice>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Registered" value={jurors.data!.length} />
                <Stat label="Eligible now" value={totals.eligible} hint="3 needed per round" />
                <Stat label="Staked" value={fmtUsdc(totals.total)} />
                <Stat label="Locked in cases" value={fmtUsdc(totals.locked)} />
              </div>
              {jurors.data!.length === 0 ? (
                <p className="text-sm text-muted">No jurors approved yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted">
                        <th className="py-1.5 font-medium">Juror</th>
                        <th className="py-1.5 font-medium">Status</th>
                        <th className="py-1.5 text-right font-medium">Total</th>
                        <th className="py-1.5 text-right font-medium">Locked</th>
                        <th className="py-1.5 text-right font-medium">Free</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jurors.data!.map((j) => (
                        <JurorRow key={j.address} j={j} seatStake={seatStake} me={address} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Card>

        <aside className="space-y-6">
          <Card title="Your juror stake" subtitle={seatStake !== undefined ? `Per seat: ${fmtUsdc(seatStake)} locked while a case is open.` : undefined}>
            <RequireWallet why="Connect the juror wallet to see and manage its stake.">
              {!me.data ? (
                <Skeleton className="h-24" />
              ) : !me.data.approved ? (
                <Notice tone="neutral" title="This address is not an approved juror">
                  The market owner approves juror addresses (approveJuror). Anyone can see the pool; only approved addresses can stake and be drawn.
                </Notice>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="Total" value={fmtUsdc(me.data.total, { symbol: false })} />
                    <Stat label="Locked" value={fmtUsdc(me.data.locked, { symbol: false })} />
                    <Stat label="Free" value={fmtUsdc(me.data.free, { symbol: false })} />
                  </div>
                  <div>
                    <div className="section-title mb-1">Deposit stake</div>
                    <DepositAction label="Deposit stake" functionName="depositJurorStake" hint={seatStake !== undefined ? `≥ ${fmtUsdc(seatStake)} free to be drawn` : undefined} />
                  </div>
                  <div>
                    <div className="section-title mb-1">Withdraw free stake</div>
                    <WithdrawAction label="Withdraw stake" functionName="withdrawJurorStake" max={me.data.free} />
                  </div>
                </div>
              )}
            </RequireWallet>
          </Card>
          {address && (
            <Card title="Your seats" subtitle="Cases this wallet was drawn for (JurorsSelected events).">
              {mySeats.length === 0 ? (
                <p className="text-sm text-muted">None yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {mySeats.map((s) => (
                    <li key={`${s.disputeId}-${s.round}`}>
                      <Link href={`/dispute/${s.disputeId}`} className="link">
                        Dispute #{s.disputeId}
                      </Link>{" "}
                      <span className="text-xs text-muted">round {s.round}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {params.data && (
            <Card title="Juror economics">
              <dl className="kv text-[13px]">
                <dt>Stake per seat</dt>
                <dd>{fmtUsdc(params.data.jurorStake)}</dd>
                <dt>Participation</dt>
                <dd>{fmtUsdc(params.data.participationFee)} per revealing juror, from the case fee</dd>
                <dt>Minority slash</dt>
                <dd>{pct(params.data.minoritySlashBps)} of seat stake → majority</dd>
                <dt>Non-reveal slash</dt>
                <dd>{pct(params.data.nonRevealSlashBps)} of seat stake → reserve</dd>
                <dt>Windows</dt>
                <dd>
                  commit {params.data.commitWindow} s · reveal {params.data.revealWindow} s
                </dd>
              </dl>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

function JurorRow({ j, seatStake, me }: { j: JurorInfo; seatStake?: bigint; me?: string }) {
  const eligible = j.approved && seatStake !== undefined && j.free >= seatStake;
  return (
    <tr className={cx("border-t border-line", me?.toLowerCase() === j.address.toLowerCase() && "bg-accent-soft")}>
      <td className="py-1.5">
        <AddressLink address={j.address} />
      </td>
      <td className="py-1.5">
        {!j.approved ? <span className="badge badge-neutral">not approved</span> : eligible ? <span className="badge badge-ok">eligible</span> : <span className="badge badge-warn">stake too low</span>}
      </td>
      <td className="py-1.5 text-right tabular-nums">{fmtUsdc(j.total, { symbol: false })}</td>
      <td className="py-1.5 text-right tabular-nums">{fmtUsdc(j.locked, { symbol: false })}</td>
      <td className="py-1.5 text-right tabular-nums">{fmtUsdc(j.free, { symbol: false })}</td>
    </tr>
  );
}

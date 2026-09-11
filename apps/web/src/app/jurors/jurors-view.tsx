"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccount } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { DepositAction, WithdrawAction } from "@/components/token-action";
import { RequireWallet } from "@/components/tx";
import { AddressLink, Card, Chip, IconArrowRight, Notice, PageHeader, Skeleton, Stat, cx } from "@/components/ui";
import { fmtUsdc, fmtWindow, pct } from "@/lib/format";
import { fetchJurorInfo, fetchJurors, GROUND_LABEL, isMechanical, useMarketConstants, useMarketEvents, useMarketParams, type JurorInfo } from "@/lib/market";
import { ClaimBanner } from "../purchase/[id]/purchase-view";

/** The dispute grounds openDispute sends to a jury. */
const JURY_GROUNDS = Object.entries(GROUND_LABEL)
  .filter(([g]) => !isMechanical(Number(g)))
  .map(([, label]) => `“${label}”`)
  .join(", ");

export function JurorsView() {
  const consts = useMarketConstants();
  return (
    <div className="space-y-8">
      <PageHeader title="Jurors">
        {consts.data ? (
          <>
            Jurors drawn at random from this pool, {consts.data.seats} per case, decide disputes filed as {JURY_GROUNDS}.
          </>
        ) : null}
      </PageHeader>
      <DeploymentGate>
        <Body />
      </DeploymentGate>
    </div>
  );
}

function Body() {
  const { address } = useAccount();
  const params = useMarketParams();
  const consts = useMarketConstants();
  const jurors = useQuery({ queryKey: ["jurors"], queryFn: fetchJurors, refetchInterval: 10_000 });
  const me = useQuery({ queryKey: ["juror", address], queryFn: () => fetchJurorInfo(address!), enabled: !!address, refetchInterval: 6_000 });
  const events = useMarketEvents();
  const seatStake = params.data?.jurorStake;
  // the stake and cases panels are only for approved jurors; everyone else sees the pool and the pay rules
  const isJuror = !!address && !!me.data?.approved;
  const mySeats = useMemo(() => {
    if (!address || !events.data) return [];
    const lc = address.toLowerCase();
    return events.data
      .filter((e) => e.eventName === "JurorsSelected" && Array.isArray(e.args.jurors) && (e.args.jurors as string[]).some((j) => j.toLowerCase() === lc))
      .map((e) => ({ disputeId: String(e.args.disputeId), round: Number(e.args.round) }))
      .reverse();
  }, [address, events.data]);

  // jurorList keeps removed jurors (approved = false), so count approval explicitly
  const totals = (jurors.data ?? []).reduce(
    (a, j) => ({
      total: a.total + j.total,
      locked: a.locked + j.locked,
      approved: a.approved + (j.approved ? 1 : 0),
      covered: a.covered + (j.approved && seatStake !== undefined && j.free >= seatStake ? 1 : 0),
    }),
    { total: 0n, locked: 0n, approved: 0, covered: 0 },
  );

  return (
    <>
      <ClaimBanner />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="pool-title" className="min-w-0 space-y-4">
          <h2 id="pool-title" className="text-sm font-semibold text-ink">
            Juror pool
          </h2>
          {jurors.isLoading ? (
            <Skeleton className="h-48" />
          ) : jurors.error ? (
            <Notice tone="bad" title="Couldn’t read the juror pool">
              {(jurors.error as Error).message.split("\n")[0]} Reload the page to try again.
            </Notice>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <Stat label="Approved" value={totals.approved} hint={consts.data ? `of ${consts.data.maxJurors} max` : undefined} />
                <Stat label="Free stake ≥ juror stake" value={totals.covered} hint={consts.data ? `${consts.data.seats} seats per case` : undefined} />
                <Stat label="Staked" value={fmtUsdc(totals.total, { symbol: false })} />
                <Stat label="Locked in cases" value={fmtUsdc(totals.locked, { symbol: false })} />
              </div>
              {jurors.data!.length === 0 ? (
                <p className="text-sm text-muted">No jurors approved yet.</p>
              ) : (
                <div className="card overflow-x-auto">
                  <table className="data-table min-w-[520px]">
                    <thead>
                      <tr>
                        <th scope="col">Juror</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="text-right">
                          Staked
                        </th>
                        <th scope="col" className="text-right">
                          Locked
                        </th>
                        <th scope="col" className="text-right">
                          Free
                        </th>
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
            </>
          )}
        </section>

        <aside className="space-y-6">
          {!isJuror && <p className="px-1 text-sm text-muted">Jurors are approved by the market operator.</p>}
          {isJuror && me.data && (
          <Card title="Your juror stake" subtitle={seatStake !== undefined ? `Each case locks ${fmtUsdc(seatStake)} until it’s decided.` : undefined}>
            <RequireWallet why="Sign in with the juror wallet to see and manage its stake.">
                <div className="space-y-5">
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="Staked" value={fmtUsdc(me.data.total, { symbol: false })} />
                    <Stat label="Locked" value={fmtUsdc(me.data.locked, { symbol: false })} />
                    <Stat label="Free" value={fmtUsdc(me.data.free, { symbol: false })} />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-ink">Add stake</div>
                    <DepositAction label="Deposit" functionName="depositJurorStake" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-ink">Withdraw free stake</div>
                    <WithdrawAction label="Withdraw" functionName="withdrawJurorStake" max={me.data.free} />
                  </div>
                </div>
            </RequireWallet>
          </Card>
          )}

          {isJuror && (
            <Card title="Your cases" subtitle="Disputes this wallet was drawn for.">
              {mySeats.length === 0 ? (
                <p className="text-sm text-muted">None yet.</p>
              ) : (
                <ul className="-my-1 divide-y divide-line">
                  {mySeats.map((s) => (
                    <li key={`${s.disputeId}-${s.round}`}>
                      <Link href={`/dispute/${s.disputeId}`} className="group flex items-center justify-between py-2 text-sm">
                        <span className="text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-[3px]">Dispute #{s.disputeId}</span>
                        <span className="flex items-center gap-1.5 text-xs text-muted">
                          round {s.round} <IconArrowRight className="h-3 w-3" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {params.data && (
            <section aria-labelledby="econ-title" className="space-y-3 px-1">
              <h2 id="econ-title" className="text-sm font-semibold text-ink">
                How jurors are paid
              </h2>
              <dl className="kv">
                <dt>Stake per case</dt>
                <dd className="font-mono tabular-nums">{fmtUsdc(params.data.jurorStake)}</dd>
                <dt>Revealed vote</dt>
                <dd>
                  <span className="font-mono tabular-nums">{fmtUsdc(params.data.participationFee)}</span> of the <span className="font-mono tabular-nums">{fmtUsdc(params.data.caseFee)}</span> case fee
                </dd>
                <dt>Minority vote</dt>
                <dd>loses {pct(params.data.minoritySlashBps)} of the case stake to the majority</dd>
                <dt>No reveal</dt>
                <dd>loses {pct(params.data.nonRevealSlashBps)} of the case stake to the reserve</dd>
                <dt>Voting time</dt>
                <dd>
                  {fmtWindow(params.data.commitWindow)} to vote, then {fmtWindow(params.data.revealWindow)} to reveal
                </dd>
              </dl>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function JurorRow({ j, seatStake, me }: { j: JurorInfo; seatStake?: bigint; me?: string }) {
  const covered = seatStake !== undefined && j.free >= seatStake;
  const isMe = me?.toLowerCase() === j.address.toLowerCase();
  return (
    <tr className={cx(isMe && "bg-accent-soft")}>
      <td>
        <span className="inline-flex items-center gap-2">
          <AddressLink address={j.address} />
          {isMe && <Chip tone="accent">you</Chip>}
        </span>
      </td>
      <td>{!j.approved ? <Chip>not approved</Chip> : seatStake === undefined ? null : covered ? <Chip tone="ok">free ≥ juror stake</Chip> : <Chip tone="warn">free &lt; juror stake</Chip>}</td>
      <td className="text-right font-mono">{fmtUsdc(j.total, { symbol: false })}</td>
      <td className="text-right font-mono">{fmtUsdc(j.locked, { symbol: false })}</td>
      <td className="text-right font-mono">{fmtUsdc(j.free, { symbol: false })}</td>
    </tr>
  );
}

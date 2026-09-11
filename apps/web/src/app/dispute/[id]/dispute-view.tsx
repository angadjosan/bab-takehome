"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import { AddressLink, Card, Countdown, Empty, HashValue, Notice, Skeleton, cx, useNow, TxLink } from "@/components/ui";
import { marketAbi } from "@/lib/abi";
import { blockUrl, deployment } from "@/lib/config";
import { useDoc } from "@/lib/docs";
import { fmtTime, fmtUsdc, maskToIndexes, pct } from "@/lib/format";
import {
  DISPUTE_STATUS,
  GROUND_HELP,
  GROUND_LABEL,
  VERDICTS,
  eventsForDispute,
  isMechanical,
  isZeroHash,
  useBlockNumber,
  useDispute,
  useMarketEvents,
  usePurchase,
  type Dispute,
  type Purchase,
  type Seat,
} from "@/lib/market";
import type { MarketEvent } from "@/lib/client";
import { ClaimBanner, StateBadge } from "../../purchase/[id]/purchase-view";

function parseId(id: string): bigint | null {
  return /^\d+$/.test(id) && id.length < 30 ? BigInt(id) : null;
}

export function DisputeView({ id }: { id: string }) {
  return (
    <DeploymentGate>
      <Inner id={parseId(id)} raw={id} />
    </DeploymentGate>
  );
}

function Inner({ id, raw }: { id: bigint | null; raw: string }) {
  const d = useDispute(id);
  const p = usePurchase(d.data?.purchaseId ?? null);
  if (id === null) return <Empty title={`“${raw}” is not a dispute id`} />;
  if (d.isLoading || (d.data && p.isLoading)) return <Skeleton className="h-96" />;
  if (d.error || !d.data) return <Empty title={`Dispute #${raw} not found`}>{(d.error as Error)?.message}</Empty>;
  if (!p.data) return <Empty title="Purchase not found">{(p.error as Error)?.message}</Empty>;
  return <Body d={d.data} p={p.data} />;
}

function Body({ d, p }: { d: Dispute; p: Purchase }) {
  const events = useMarketEvents();
  const mine = useMemo(() => (events.data ? eventsForDispute(events.data, d.id) : []), [events.data, d.id]);
  const resolved = d.status === 3;
  const verdictTone = d.verdict === 1 ? "badge-ok" : d.verdict === 2 ? "badge-neutral" : "badge-warn";

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/purchase/${p.id}`} className="text-xs text-muted hover:text-ink">
          ← Purchase #{p.id.toString()}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Dispute #{d.id.toString()}</h1>
          <span className="badge badge-warn">{GROUND_LABEL[d.ground]}</span>
          <span className={cx("badge", resolved ? verdictTone : "badge-info")}>{resolved ? VERDICTS[d.verdict] : DISPUTE_STATUS[d.status]}</span>
          {d.fallbackNoQuorum && <span className="badge badge-neutral">no-fault fallback</span>}
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted">{GROUND_HELP[d.ground]}</p>
      </div>

      <ClaimBanner />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <ClaimCard d={d} p={p} />
          {isMechanical(d.ground) ? <MechanicalCard d={d} events={mine} /> : <JuryCard d={d} events={mine} />}
          {resolved && <OutcomeCard d={d} p={p} />}
        </div>
        <aside className="space-y-6">
          <Card title="Purchase">
            <dl className="kv text-[13px]">
              <dt>Purchase</dt>
              <dd>
                <Link href={`/purchase/${p.id}`} className="link">
                  #{p.id.toString()}
                </Link>{" "}
                <StateBadge state={p.state} />
              </dd>
              <dt>Buyer</dt>
              <dd>
                <AddressLink address={p.buyer} seller />
              </dd>
              <dt>Seller</dt>
              <dd>
                <AddressLink address={p.seller} seller />
              </dd>
              <dt>Price</dt>
              <dd>{fmtUsdc(p.price)}</dd>
              <dt>Version</dt>
              <dd>
                <Link href={`/listing/${p.versionId}`} className="link">
                  #{p.versionId.toString()}
                </Link>
              </dd>
            </dl>
          </Card>
          <Card title="Dispute history">{events.isLoading ? <Skeleton className="h-24" /> : <EventList events={[...mine].reverse()} compact />}</Card>
        </aside>
      </div>
    </div>
  );
}

function ClaimCard({ d, p }: { d: Dispute; p: Purchase }) {
  const ev = useDoc("", isZeroHash(d.evidenceHash) ? undefined : d.evidenceHash);
  return (
    <Card title="The claim" subtitle={`Opened ${fmtTime(d.openedAt)} by the buyer before the challenge deadline.`}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Mini label="Tasks disputed" value={maskToIndexes(d.taskMask).map((i) => `#${i + 1}`).join(", ")} hint={`of ${p.taskCount}`} />
        <Mini label="Requested refund" value={fmtUsdc(d.requested)} hint={`cap ${pct(p.refundCapBps)} of price`} />
        <Mini label="Buyer bond" value={fmtUsdc(d.bond)} hint="returned if upheld" />
        <Mini label="Case fee" value={fmtUsdc(d.caseFee)} hint="paid by the loser" />
      </div>
      <div className="mt-5">
        <div className="section-title">Evidence</div>
        <div className="mt-1 text-xs text-muted">
          evidenceHash <HashValue value={d.evidenceHash} />
        </div>
        {ev.data ? (
          <div className="mt-2 rounded-lg border border-line bg-panel-2 p-3">
            <div className="mb-1 text-[11px] text-muted">{ev.data.ok ? "✓ text matches the on-chain evidenceHash" : "✗ text does not match evidenceHash"}</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{ev.data.text}</pre>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">{ev.isLoading ? "Looking up the evidence text…" : "The evidence text was not published; reviewers receive a case packet from the TEE."}</p>
        )}
      </div>
    </Card>
  );
}

function Mini({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div>
      <div className="section-title">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

/* --------------------------------- mechanical --------------------------------- */

function MechanicalCard({ d, events }: { d: Dispute; events: MarketEvent[] }) {
  const now = useNow();
  const tx = useTx();
  const res = events.find((e) => e.eventName === "MechanicalResolved");
  const pending = d.status === 2;
  return (
    <Card
      title="Mechanical review"
      subtitle={d.ground === 1 ? "The TEE verifier re-checks hashes, the key, the build, and declared execution." : "The TEE runner repeats the committed reference protocol and compares against the signed preview."}
    >
      {pending ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Under review. The verifier signs a MechanicalFinding (upheld, confirmed task mask, findings hash) that the contract checks against an authorized verifier address.
          </p>
          <dl className="kv">
            <dt>Verifier deadline</dt>
            <dd>
              {fmtTime(d.verifierDeadline)} · <Countdown to={d.verifierDeadline} doneText="passed" />
            </dd>
          </dl>
          {now > d.verifierDeadline && (
            <>
              <Notice tone="warn" title="The verifier did not answer in time">
                Anyone can apply the precommitted no-fault fallback: the buyer’s bond is returned in full, no refund, and the purchase settles normally. A runner outage proves neither side at fault.
              </Notice>
              <RequireWallet why="Connect any wallet; this is permissionless.">
                <button className="btn btn-primary" disabled={tx.busy} onClick={() => tx.run("Timeout", { address: deployment!.market, abi: marketAbi, functionName: "timeoutMechanical", args: [d.id] })}>
                  Apply verifier-timeout fallback
                </button>
              </RequireWallet>
              <TxStatus state={tx.state} />
            </>
          )}
        </div>
      ) : res ? (
        <dl className="kv text-sm">
          <dt>Finding</dt>
          <dd>{res.args.upheld ? "Upheld: defect confirmed" : "Rejected: no defect confirmed"}</dd>
          <dt>Confirmed tasks</dt>
          <dd>{maskToIndexes(BigInt(res.args.confirmedMask as bigint)).map((i) => `#${i + 1}`).join(", ") || "none"}</dd>
          <dt>Findings hash</dt>
          <dd>
            <HashValue value={String(res.args.findingsHash)} />
          </dd>
          <dt>Verifier</dt>
          <dd>
            <AddressLink address={String(res.args.verifier ?? "")} />
          </dd>
          <dt>Transaction</dt>
          <dd>
            <TxLink hash={res.transactionHash} />
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted">{d.fallbackNoQuorum ? "Resolved by the verifier-timeout fallback." : "No finding recorded."}</p>
      )}
    </Card>
  );
}

/* ------------------------------------ jury ------------------------------------ */

function JuryCard({ d, events }: { d: Dispute; events: MarketEvent[] }) {
  const now = useNow();
  const block = useBlockNumber();
  const select = useTx();
  const tally = useTx();
  const m = deployment!.market;
  const selections = events.filter((e) => e.eventName === "JurorsSelected");
  const rounds = Array.from(new Set([1, ...selections.map((e) => Number(e.args.round)), d.round])).filter((r) => r >= 1 && r <= 2).sort();
  const awaiting = d.status === 1;
  const voting = d.status === 2;
  const cur = block.data;
  const canSelect = awaiting && cur !== undefined && cur > d.selectionBlock;
  const roundSeats = d.seats.slice((d.round - 1) * 3, d.round * 3);
  const allRevealed = roundSeats.every((s) => s.revealed);
  const canTally = voting && (now > d.revealDeadline || allRevealed);

  return (
    <Card title="AI jury (commit–reveal)" subtitle="Three approved, staked juror agents are drawn at random, excluding the buyer and seller. Votes are sealed, then revealed.">
      <div className="space-y-5">
        {awaiting && (
          <div className="rounded-lg border border-line p-4 text-sm">
            <div className="font-medium">Round {d.round}: waiting for the random draw</div>
            <p className="mt-1 text-muted">
              Randomness comes from <span className="font-mono">keccak256(blockhash({d.selectionBlock.toString()}), prevrandao, disputeId, round)</span>, a block that did not exist when the dispute was
              opened.{" "}
              {cur !== undefined &&
                (cur > d.selectionBlock ? (
                  <>Block {d.selectionBlock.toString()} is mined, so anyone can draw the panel now.</>
                ) : (
                  <>
                    Current block {cur.toString()}; {(d.selectionBlock - cur + 1n).toString()} more to go.
                  </>
                ))}
            </p>
            {blockUrl(d.selectionBlock) && (
              <a href={blockUrl(d.selectionBlock)!} target="_blank" rel="noreferrer" className="link text-xs">
                selection block {d.selectionBlock.toString()}
              </a>
            )}
            <p className="mt-1 text-xs text-muted">
              If three eligible jurors can’t be seated by {fmtTime(d.selectionDeadline)}, the round counts as failed.
            </p>
            <RequireWallet why="Drawing the panel is permissionless; any wallet can submit it.">
              <button className="btn btn-primary mt-3" disabled={!canSelect || select.busy} onClick={() => select.run("Select jurors", { address: m, abi: marketAbi, functionName: "selectJurors", args: [d.id] })}>
                Select jurors
              </button>
            </RequireWallet>
            <TxStatus state={select.state} />
          </div>
        )}

        {rounds.map((r) => {
          const sel = selections.find((e) => Number(e.args.round) === r);
          const seats = d.seats.slice((r - 1) * 3, r * 3);
          if (!sel && seats.every((s) => /^0x0+$/.test(s.juror))) return null;
          const isCur = r === d.round && voting;
          const commitDl = sel ? Number(sel.args.commitDeadline) : d.commitDeadline;
          const revealDl = sel ? Number(sel.args.revealDeadline) : d.revealDeadline;
          return (
            <div key={r} className="rounded-lg border border-line">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-sm">
                <span className="font-medium">
                  Round {r} {r === 2 && <span className="text-xs font-normal text-muted">(fresh panel, round-1 jurors excluded)</span>}
                </span>
                {sel && (
                  <span className="text-xs text-muted">
                    seed <HashValue value={String(sel.args.seed ?? "")} /> · <TxLink hash={sel.transactionHash} label="draw tx" />
                  </span>
                )}
              </div>
              {sel && (
                <div className="grid grid-cols-2 gap-3 border-b border-line px-4 py-2.5 text-xs">
                  <div>
                    <span className="text-muted">Commit deadline</span>
                    <div>
                      {fmtTime(commitDl)} {isCur && <>· <Countdown to={commitDl} doneText="closed" /></>}
                    </div>
                  </div>
                  <div>
                    <span className="text-muted">Reveal deadline</span>
                    <div>
                      {fmtTime(revealDl)} {isCur && <>· <Countdown to={revealDl} doneText="closed" /></>}
                    </div>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th className="px-4 py-2 font-medium">Seat</th>
                      <th className="px-4 py-2 font-medium">Juror</th>
                      <th className="px-4 py-2 font-medium">Commit</th>
                      <th className="px-4 py-2 font-medium">Reveal</th>
                      <th className="px-4 py-2 font-medium">Paid / slashed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seats.map((s, i) => (
                      <SeatRow key={i} i={i} s={s} events={events} round={r} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

        {voting && (
          <div className="rounded-lg bg-panel-2 p-4 text-sm">
            <div className="font-medium">Tally</div>
            <p className="mt-1 text-muted">
              Anyone can tally once the reveal deadline passes (or earlier if all three revealed). A strict majority of ≥ 2 reveals decides. Otherwise non-revealers are slashed and{" "}
              {d.round === 1 ? "a fresh round-2 panel is drawn" : "the no-quorum fallback applies: bond returned, no refund, purchase settles normally"}.
            </p>
            <RequireWallet why="Tallying is permissionless.">
              <button className="btn btn-primary mt-3" disabled={!canTally || tally.busy} onClick={() => tally.run("Tally", { address: m, abi: marketAbi, functionName: "tallyDispute", args: [d.id] })}>
                Tally votes
              </button>
              {!canTally && (
                <span className="ml-3 text-xs text-muted">
                  available in <Countdown to={d.revealDeadline} />
                </span>
              )}
            </RequireWallet>
            <TxStatus state={tally.state} />
          </div>
        )}

        <p className="text-xs text-muted">
          Juror economics (snapshotted): stake {fmtUsdc(d.jurorStake)} locked per seat; each revealing juror earns {fmtUsdc(d.participationFee)} from the case fee; the rest plus {pct(d.minoritySlashBps)} of each
          minority seat’s stake goes to the majority; non-revealers lose {pct(d.nonRevealSlashBps)} of their stake to the reserve. Agreement with the majority does not establish truth; jurors may share a base
          model’s mistakes.
        </p>
      </div>
    </Card>
  );
}

function SeatRow({ i, s, events, round }: { i: number; s: Seat; events: MarketEvent[]; round: number }) {
  const empty = /^0x0+$/.test(s.juror);
  const commitEv = events.find((e) => e.eventName === "VoteCommitted" && Number(e.args.round) === round && String(e.args.juror).toLowerCase() === s.juror.toLowerCase());
  const revealEv = events.find((e) => e.eventName === "VoteRevealed" && Number(e.args.round) === round && String(e.args.juror).toLowerCase() === s.juror.toLowerCase());
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-2.5 text-muted">{i + 1}</td>
      <td className="px-4 py-2.5">{empty ? <span className="text-faint">not drawn</span> : <AddressLink address={s.juror} />}</td>
      <td className="px-4 py-2.5">
        {!isZeroHash(s.commitment) ? (
          <span className="inline-flex items-center gap-1">
            <span className="badge badge-ok">sealed</span>
            {commitEv && <TxLink hash={commitEv.transactionHash} label="tx" />}
          </span>
        ) : (
          <span className="badge badge-neutral">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {s.revealed ? (
          <span className="inline-flex items-center gap-1">
            <span className={cx("badge", s.vote === 1 ? "badge-ok" : "badge-bad")}>{s.vote === 1 ? "Uphold" : "Reject"}</span>
            {revealEv && <TxLink hash={revealEv.transactionHash} label="tx" />}
          </span>
        ) : (
          <span className="badge badge-neutral">hidden</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs tabular-nums">
        {s.reward > 0n && <span className="text-ok">+{fmtUsdc(s.reward)}</span>}
        {s.slashed > 0n && <span className="ml-2 text-bad">−{fmtUsdc(s.slashed)}</span>}
        {s.reward === 0n && s.slashed === 0n && <span className="text-faint">—</span>}
      </td>
    </tr>
  );
}

/* ---------------------------------- outcome ---------------------------------- */

function OutcomeCard({ d, p }: { d: Dispute; p: Purchase }) {
  const upheld = d.verdict === 1;
  const jurorPaid = d.seats.reduce((a, s) => a + s.reward, 0n);
  const jurorSlashed = d.seats.reduce((a, s) => a + s.slashed, 0n);
  const rows: [string, string, string][] = [
    ["Refund to buyer", fmtUsdc(d.refund), upheld ? `${maskToIndexes(d.confirmedMask).length} confirmed task(s) × per-task price, within the cap` : "none"],
    ["Bond", fmtUsdc(d.bond), upheld || d.fallbackNoQuorum ? "returned to the buyer in full" : `case fee taken from it; remainder → neutral reserve`],
    ["Seller proceeds", fmtUsdc(p.sellerProceeds), "retained price minus marketplace fee"],
    ["Marketplace fee", fmtUsdc(p.fee), "to treasury"],
    ["Seller penalties", fmtUsdc(p.penalties), "extra collateral slash → neutral reserve"],
    ["Case fee", fmtUsdc(d.caseFee), upheld ? "paid from seller collateral" : d.fallbackNoQuorum ? "not charged (no fault)" : "paid from the buyer’s bond"],
  ];
  if (!isMechanical(d.ground)) {
    rows.push(["Juror rewards", fmtUsdc(jurorPaid), "participation + majority share"]);
    rows.push(["Juror slashes", fmtUsdc(jurorSlashed), "minority / non-reveal"]);
  }
  return (
    <Card title="Outcome & settlement" subtitle={`Resolved ${fmtTime(d.resolvedAt)}. All payouts are credited as claimable balances.`}>
      <div className={cx("mb-4 rounded-lg px-4 py-3 text-sm", upheld ? "bg-ok-soft text-ok" : "bg-panel-2 text-muted")}>
        <span className="font-semibold">{VERDICTS[d.verdict]}</span>
        {d.fallbackNoQuorum && " · resolved by the precommitted no-quorum / timeout fallback"}
        {upheld && d.confirmedMask > 0n && ` · confirmed tasks ${maskToIndexes(d.confirmedMask).map((i) => `#${i + 1}`).join(", ")}`}
      </div>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([k, v, hint]) => (
          <div key={k} className="flex items-start justify-between gap-3 py-2">
            <dt>
              {k}
              <div className="text-[11px] text-muted">{hint}</div>
            </dt>
            <dd className="font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

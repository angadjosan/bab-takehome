"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import {
  AddressLink,
  Card,
  Chip,
  Countdown,
  DetailSection,
  Details,
  Empty,
  HashValue,
  IconCheck,
  Notice,
  PageHeader,
  Skeleton,
  Spinner,
  Stat,
  TxLink,
  Verified,
  cx,
  useNow,
  type Tone,
} from "@/components/ui";
import { marketAbi } from "@/lib/abi";
import { blockUrl, CHAIN_ID, deployment } from "@/lib/config";
import { useHealth } from "@/lib/docs";
import { fmtTime, fmtUsdc, maskToIndexes, pct } from "@/lib/format";
import { eventsForDispute, isMechanical, isZeroHash, readOptional, useBlockNumber, useDispute, useMarketEvents, usePurchase, type Dispute, type Purchase, type Seat } from "@/lib/market";
import type { MarketEvent } from "@/lib/client";
import { eqHash, sha256Hex } from "@/lib/crypto";
import { fetchBlob, fetchRationale, getFindings, loadLocalEvidence, requestCasePacket, type CasePacket, type RationaleDoc } from "@/lib/tee";
import { ClaimBanner, StateBadge } from "../../purchase/[id]/purchase-view";

function parseId(id: string): bigint | null {
  return /^\d+$/.test(id) && id.length < 30 ? BigInt(id) : null;
}

const isEmptyAddr = (a: string) => /^0x0+$/.test(a);
const roundSeats = (d: Dispute, round = d.round) => d.seats.slice((round - 1) * 3, round * 3);

/** "task 2" · "tasks 2 and 4" · "tasks 1, 2 and 4" */
function taskList(mask: bigint) {
  const ix = maskToIndexes(mask).map((i) => i + 1);
  if (!ix.length) return { text: "no tasks", n: 0 };
  if (ix.length === 1) return { text: `task ${ix[0]}`, n: 1 };
  return { text: `tasks ${ix.slice(0, -1).join(", ")} and ${ix[ix.length - 1]}`, n: ix.length };
}

/** One plain sentence for the claim, by ground. */
function claimSentence(d: Dispute) {
  const t = taskList(d.taskMask);
  const one = t.n === 1;
  const what =
    d.ground === 1
      ? one
        ? "is broken or doesn’t match the listing"
        : "are broken or don’t match the listing"
      : d.ground === 2
        ? one
          ? "contradicts the description"
          : "contradict the description"
        : one
          ? "doesn’t reproduce its preview score"
          : "don’t reproduce their preview scores";
  return `The buyer says ${t.text} ${what}`;
}

function outcomeLabel(d: Dispute): { text: string; tone: Tone } {
  if (d.fallbackNoQuorum) return { text: "Closed, no fault", tone: "neutral" };
  return d.verdict === 1 ? { text: "Buyer wins", tone: "ok" } : { text: "Seller wins", tone: "neutral" };
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
  if (id === null) return <Empty title={`“${raw}” isn’t a dispute number`}>Dispute numbers are whole numbers, like /dispute/1.</Empty>;
  if (d.isLoading || (d.data && p.isLoading))
    return (
      <div className="max-w-4xl space-y-6" aria-busy="true">
        <span className="sr-only">Loading dispute…</span>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );
  if (d.error || !d.data)
    return (
      <Empty title={`Dispute #${raw} not found`} action={<Link href="/activity?filter=disputes" className="btn btn-sm">See all disputes</Link>}>
        {(d.error as Error)?.message?.split("\n")[0] ?? "There is no dispute with that number on this market."}
      </Empty>
    );
  if (!p.data) return <Empty title="The purchase behind this dispute wasn’t found">{(p.error as Error)?.message?.split("\n")[0]}</Empty>;
  return <Body d={d.data} p={p.data} />;
}

function Body({ d, p }: { d: Dispute; p: Purchase }) {
  const { address } = useAccount();
  const events = useMarketEvents();
  const mine = useMemo(() => (events.data ? eventsForDispute(events.data, d.id) : []), [events.data, d.id]);
  const resolved = d.status === 3;
  const mechanical = isMechanical(d.ground);
  const hasSeat = !!address && d.status === 2 && roundSeats(d).some((s) => s.juror.toLowerCase() === address.toLowerCase());
  const status = resolved ? outcomeLabel(d) : { text: d.status === 1 ? "Waiting for jury" : mechanical ? "Under review" : "Jury voting", tone: "warn" as Tone };

  return (
    <div className="max-w-4xl space-y-10">
      <PageHeader
        back={{ href: `/purchase/${p.id}`, label: `Purchase #${p.id.toString()}` }}
        eyebrow={`Dispute #${d.id.toString()}`}
        title={claimSentence(d)}
        meta={
          <>
            <Chip tone={status.tone} dot>
              {status.text}
            </Chip>
            <span>
              Asks for <span className="font-mono text-ink tabular-nums">{fmtUsdc(d.requested)}</span> back
            </span>
            <span>
              <span className="font-mono text-ink tabular-nums">{fmtUsdc(d.bond)}</span> deposit
            </span>
            <Link href={`/listing/${p.versionId}`} className="link">
              Environment #{p.versionId.toString()}
            </Link>
          </>
        }
      >
        {mechanical
          ? "The TEE verifier re-checks the disputed tasks and signs a finding. No people or jurors are involved."
          : "Three staked AI jurors, drawn at random, decide. They vote in secret, then reveal their votes."}
      </PageHeader>

      <ClaimBanner />

      <Stages d={d} />

      {!mechanical && <MyJurySeat d={d} />}
      {mechanical ? <MechanicalCard d={d} events={mine} /> : <JuryCard d={d} events={mine} primary={!hasSeat} />}
      {resolved && <OutcomeCard d={d} p={p} />}
      <ClaimCard d={d} p={p} />

      <Details summary="Details: randomness, evidence hash, jurors’ addresses and transactions">
        <DetailSection title="Parties">
          <dl className="kv">
            <dt>Purchase</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <Link href={`/purchase/${p.id}`} className="link">
                #{p.id.toString()}
              </Link>
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
            <dt>Price paid</dt>
            <dd className="font-mono tabular-nums">{fmtUsdc(p.price)}</dd>
          </dl>
        </DetailSection>
        <DetailSection title="Evidence" hint="The buyer’s evidence is stored privately by the TEE. Only its sha256 is public, on-chain.">
          <HashValue value={d.evidenceHash} />
        </DetailSection>
        {mechanical ? (
          <>
            <MechanicalDetails events={mine} />
            <FindingsSection d={d} />
          </>
        ) : (
          <>
            <JuryDetails d={d} events={mine} />
            <RationalesSection d={d} />
            <DetailSection title="How jurors are paid">
              <p className="text-xs leading-relaxed text-muted">
                Each seat locks {fmtUsdc(d.jurorStake)} of stake. A juror who reveals earns up to {fmtUsdc(d.participationFee)} from the case fee; the rest, plus {pct(d.minoritySlashBps)} of each
                minority juror’s stake, goes to the majority. A juror who doesn’t reveal loses {pct(d.nonRevealSlashBps)} of the stake to the reserve. Agreeing with the majority doesn’t make a
                vote correct, and jurors may share a base model’s mistakes.
              </p>
            </DetailSection>
          </>
        )}
        <DetailSection title="History">{events.isLoading ? <Skeleton className="h-24" /> : <EventList events={[...mine].reverse()} />}</DetailSection>
      </Details>
    </div>
  );
}

/* --------------------------------- progress --------------------------------- */

type StageState = "done" | "active" | "todo" | "skipped";
type Stage = { label: string; state: StageState; note?: ReactNode };
const SR_STATE: Record<StageState, string> = { done: "done", active: "in progress", todo: "not started", skipped: "skipped" };

function Stages({ d }: { d: Dispute }) {
  const now = useNow();
  const resolved = d.status === 3;
  let stages: Stage[];
  if (isMechanical(d.ground)) {
    stages = [
      { label: "Reported", state: "done", note: fmtTime(d.openedAt) },
      {
        label: "Under review",
        state: resolved ? "done" : "active",
        note: resolved ? undefined : now > d.verifierDeadline ? "Deadline passed" : (
          <>
            Due in <Countdown to={d.verifierDeadline} />
          </>
        ),
      },
      { label: "Decided", state: resolved ? "done" : "todo", note: resolved ? fmtTime(d.resolvedAt) : undefined },
    ];
  } else {
    const rs = roundSeats(d);
    const drawn = d.seats.some((s) => !isEmptyAddr(s.juror));
    const anyCommit = d.seats.some((s) => !isZeroHash(s.commitment));
    const anyReveal = d.seats.some((s) => s.revealed);
    const voting = d.status === 2;
    const allCommitted = rs.every((s) => !isZeroHash(s.commitment));
    const allRevealed = rs.every((s) => s.revealed);
    const commitPhase = voting && !allCommitted && now <= d.commitDeadline;
    const revealPhase = voting && !commitPhase;
    stages = [
      { label: "Reported", state: "done", note: fmtTime(d.openedAt) },
      {
        label: d.round === 2 ? "Jury drawn (round 2)" : "Jury drawn",
        state: d.status === 1 ? "active" : drawn ? "done" : resolved ? "skipped" : "todo",
        note: d.status === 1 ? `Draw by ${fmtTime(d.selectionDeadline)}` : undefined,
      },
      {
        label: "Votes cast",
        state: commitPhase ? "active" : voting ? "done" : resolved ? (anyCommit ? "done" : "skipped") : "todo",
        note: commitPhase ? (
          <>
            Closes in <Countdown to={d.commitDeadline} />
          </>
        ) : undefined,
      },
      {
        label: "Votes revealed",
        state: revealPhase ? (allRevealed ? "done" : "active") : resolved ? (anyReveal ? "done" : "skipped") : "todo",
        note:
          revealPhase && !allRevealed ? (
            <>
              Closes in <Countdown to={d.revealDeadline} doneText="closed" />
            </>
          ) : undefined,
      },
      { label: "Decided", state: resolved ? "done" : "todo", note: resolved ? fmtTime(d.resolvedAt) : undefined },
    ];
  }
  return (
    <section aria-label="Progress">
      <ol className="grid gap-4 sm:auto-cols-fr sm:grid-flow-col sm:gap-0">
        {stages.map((s, i) => (
          <li key={s.label} aria-current={s.state === "active" ? "step" : undefined} className="flex gap-3 sm:flex-col sm:gap-2.5">
            <div className="flex items-center sm:w-full">
              <StageDot state={s.state} />
              {i < stages.length - 1 && <span aria-hidden className={cx("mx-2 hidden h-px flex-1 sm:block", s.state === "done" ? "bg-ok/40" : "bg-line")} />}
            </div>
            <div className="min-w-0 sm:pr-3">
              <div className={cx("text-[13px] font-medium", s.state === "todo" || s.state === "skipped" ? "text-muted" : "text-ink")}>
                {s.label}
                <span className="sr-only">, {SR_STATE[s.state]}</span>
              </div>
              {s.note && <div className="mt-0.5 text-xs text-muted tabular-nums">{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StageDot({ state }: { state: StageState }) {
  if (state === "done")
    return (
      <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
        <IconCheck className="h-3 w-3" />
      </span>
    );
  if (state === "active")
    return (
      <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
    );
  return <span aria-hidden className={cx("h-5 w-5 shrink-0 rounded-full border border-line-strong", state === "skipped" && "border-dashed")} />;
}

/* ---------------------------------- the claim ---------------------------------- */

function ClaimCard({ d, p }: { d: Dispute; p: Purchase }) {
  const [local, setLocal] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage only exists client-side
  useEffect(() => setLocal(loadLocalEvidence(d.id)), [d.id]);
  const localOk = local !== null && eqHash(sha256Hex(local), d.evidenceHash);
  const tasks = maskToIndexes(d.taskMask).map((i) => i + 1);
  return (
    <Card title="The claim" subtitle={`Reported ${fmtTime(d.openedAt)}, inside the buyer’s protection window.`}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat label="Tasks" value={tasks.join(", ") || "—"} hint={`of ${p.taskCount}`} />
        <Stat label="Refund asked" value={fmtUsdc(d.requested, { symbol: false })} hint={`capped at ${pct(p.refundCapBps)} of the price`} />
        <Stat label="Buyer’s deposit" value={fmtUsdc(d.bond, { symbol: false })} hint="returned if the buyer wins" />
        <Stat label="Case fee" value={fmtUsdc(d.caseFee, { symbol: false })} hint="paid by the side that loses" />
      </div>
      <div className="mt-6 border-t border-line pt-5">
        <h3 className="text-[13px] font-medium text-ink">Evidence</h3>
        {localOk ? (
          <>
            <p className="mt-1 text-xs text-muted">Your copy, saved in this browser. Seated jurors read it inside the case file the TEE sends them.</p>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{local}</pre>
          </>
        ) : (
          <p className="mt-1 text-[13px] text-muted">
            Private. The buyer uploaded it to the TEE, which shows it only to the seated jurors and the verifier.
          </p>
        )}
      </div>
    </Card>
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
      title="Review"
      subtitle={d.ground === 1 ? "The TEE verifier re-checks the files, the key, the build, and how the environment runs." : "The TEE re-runs the preview with the same models and settings and compares the scores."}
    >
      {pending ? (
        <div className="space-y-4 text-sm">
          <p className="flex items-start gap-2 text-muted">
            <Spinner className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Under review. The verifier has until {fmtTime(d.verifierDeadline)} (<Countdown to={d.verifierDeadline} doneText="passed" />) to sign a finding.
            </span>
          </p>
          {now > d.verifierDeadline && (
            <>
              <Notice tone="warn" title="The verifier missed its deadline">
                Anyone can now close the dispute with the agreed no-fault outcome. The buyer gets the deposit back, there is no refund, and the purchase completes normally.
              </Notice>
              <RequireWallet why="Anyone can close it. Sign in to send the transaction.">
                <button className="btn btn-primary" disabled={tx.busy} onClick={() => tx.run("Close with no-fault outcome", { address: deployment!.market, abi: marketAbi, functionName: "timeoutMechanical", args: [d.id] })}>
                  {tx.busy ? "Closing…" : "Close with no-fault outcome"}
                </button>
              </RequireWallet>
              <div aria-live="polite">
                <TxStatus state={tx.state} />
              </div>
            </>
          )}
        </div>
      ) : res ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Chip tone={res.args.upheld ? "ok" : "neutral"} dot>
            {res.args.upheld ? "Defect confirmed" : "No defect found"}
          </Chip>
          <span className="text-muted">
            Confirmed: {maskToIndexes(BigInt(res.args.confirmedMask as bigint)).map((i) => `task ${i + 1}`).join(", ") || "none"}
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted">{d.fallbackNoQuorum ? "Closed with the no-fault outcome after the verifier missed its deadline." : "No finding recorded."}</p>
      )}
    </Card>
  );
}

function MechanicalDetails({ events }: { events: MarketEvent[] }) {
  const res = events.find((e) => e.eventName === "MechanicalResolved");
  if (!res) return null;
  return (
    <DetailSection title="Signed finding">
      <dl className="kv">
        <dt>Findings hash</dt>
        <dd>
          <HashValue value={String(res.args.findingsHash)} />
        </dd>
        <dt>Transaction</dt>
        <dd>
          <TxLink hash={res.transactionHash} />
        </dd>
      </dl>
    </DetailSection>
  );
}

/** Public findings JSON (aggregates only) from the TEE; its sha256 is the on-chain findingsHash. */
function FindingsSection({ d }: { d: Dispute }) {
  const q = useQuery({
    queryKey: ["findings", d.id.toString(), d.findingsHash],
    refetchInterval: d.status === 3 ? false : 10_000,
    queryFn: async () => {
      const api = await getFindings(d.id).catch(() => null);
      if (api) return { findings: api.findings, computed: api.computedHash, source: "GET /findings" as const, tx: api.tx };
      if (isZeroHash(d.findingsHash)) return null;
      const { bytes } = await fetchBlob("", d.findingsHash);
      return { findings: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>, computed: sha256Hex(bytes), source: "blob store" as const, tx: null };
    },
  });
  if (q.isLoading || !q.data) return null;
  const f = q.data.findings as Record<string, unknown>;
  const onChain = !isZeroHash(d.findingsHash);
  return (
    <DetailSection title="Verifier findings" hint={`Published by the TEE (${q.data.source}). Totals only, no audit data.`}>
      <div className="mb-3">
        {onChain ? <Verified ok={eqHash(q.data.computed, d.findingsHash)} okText="sha256 matches the on-chain findingsHash" badText="hash doesn’t match the chain" /> : <Chip>not on-chain yet</Chip>}
      </div>
      <dl className="kv">
        <dt>Result</dt>
        <dd>
          {f.upheld ? "upheld" : "rejected"} · confirmed {maskToIndexes(BigInt(String(f.confirmedMask ?? "0"))).map((i) => `task ${i + 1}`).join(", ") || "none"}
        </dd>
        <dt>Rule</dt>
        <dd className="text-xs">{String(f.rule ?? "—")}</dd>
        <dt>Sandbox</dt>
        <dd className="text-xs">{typeof f.sandbox === "string" ? f.sandbox : JSON.stringify(f.sandbox ?? "—")}</dd>
        <dt>Verifier</dt>
        <dd>
          <AddressLink address={String(f.verifier ?? "")} />
        </dd>
        <dt>Attestation</dt>
        <dd className="text-xs">{String((f.attestation as { kind?: string } | undefined)?.kind ?? "—")}</dd>
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted hover:text-ink">Full findings JSON</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-[11px]">{JSON.stringify(f, null, 2)}</pre>
      </details>
    </DetailSection>
  );
}

/* ------------------------------ your jury seat (manual) ------------------------------ */

type VoteSecret = { verdict: 1 | 2; salt: Hex; commitment: Hex };
const secretKey = (d: bigint, round: number, juror: string) => `envmarket.vote.${CHAIN_ID}.${deployment?.market.toLowerCase()}.${d}.${round}.${juror.toLowerCase()}`;
function loadSecret(d: bigint, round: number, juror: string): VoteSecret | null {
  try {
    return JSON.parse(window.localStorage.getItem(secretKey(d, round, juror)) || "null");
  } catch {
    return null;
  }
}
function saveSecret(d: bigint, round: number, juror: string, s: VoteSecret) {
  window.localStorage.setItem(secretKey(d, round, juror), JSON.stringify(s));
}

/** keccak256(abi.encode(uint256 disputeId, uint8 round, uint8 verdict, bytes32 salt, address juror)) — EnvMarket.commitmentFor */
function commitmentOf(disputeId: bigint, round: number, verdict: 1 | 2, salt: Hex, juror: Address): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint256, uint8, uint8, bytes32, address"), [disputeId, round, verdict, salt, juror]));
}

/**
 * If the connected wallet holds a seat in the current round: its vote status, the TEE case packet
 * (signed challenge), and a manual commit → reveal with the salt kept in this browser. This is an
 * alternative to running the juror agent for that key — don't do both for the same juror.
 */
function MyJurySeat({ d }: { d: Dispute }) {
  const { address } = useAccount();
  const now = useNow();
  const commit = useTx();
  const reveal = useTx();
  const [secret, setSecret] = useState<VoteSecret | null>(null);
  const [choice, setChoice] = useState<1 | 2 | 0>(0);
  const [err, setErr] = useState<string | null>(null);
  const name = useId();
  const rs = roundSeats(d);
  const seat = address ? rs.find((s) => s.juror.toLowerCase() === address.toLowerCase()) : undefined;
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the vote secret lives in localStorage
  useEffect(() => setSecret(address && seat ? loadSecret(d.id, d.round, address) : null), [address, seat, d.id, d.round]);
  if (!address || !seat || d.status !== 2) return null;

  const committed = !isZeroHash(seat.commitment);
  const allCommitted = rs.every((s) => !isZeroHash(s.commitment));
  const commitOpen = now <= d.commitDeadline && !committed;
  const revealOpen = committed && !seat.revealed && (now > d.commitDeadline || allCommitted) && now <= d.revealDeadline;
  const secretMatches = !!secret && eqHash(secret.commitment, seat.commitment);

  async function doCommit() {
    if (!choice || !address) return;
    setErr(null);
    const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
    const commitment = commitmentOf(d.id, d.round, choice, salt, address);
    const onchain = (await readOptional("commitmentFor", [d.id, d.round, choice, salt, address])) as Hex | undefined;
    if (onchain && !eqHash(onchain, commitment)) {
      setErr("The contract computes a different vote seal, so nothing was sent. Reload the page and try again.");
      return;
    }
    // persist BEFORE sending: losing the salt means you cannot reveal and your stake is slashed
    const s = { verdict: choice, salt, commitment };
    saveSecret(d.id, d.round, address, s);
    setSecret(s);
    await commit.run("Cast vote", { address: deployment!.market, abi: marketAbi, functionName: "commitVote", args: [d.id, commitment] });
  }

  return (
    <section aria-labelledby="seat-title" className="space-y-5 rounded-md border border-accent/40 bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="seat-title" className="text-base font-semibold text-ink">
            You’re on this jury
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Read the case, then vote. Vote by {fmtTime(d.commitDeadline)}, reveal by {fmtTime(d.revealDeadline)}.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip tone={committed ? "ok" : "warn"} dot>
            {committed ? "Vote cast" : "Not voted yet"}
          </Chip>
          {seat.revealed && <Chip tone="ok">Revealed: {seat.vote === 1 ? "uphold" : "reject"}</Chip>}
        </div>
      </div>

      <CasePacketView disputeId={d.id} juror={address} />

      {commitOpen && (
        <fieldset className="space-y-3">
          <legend className="text-[13px] font-medium text-ink">Your vote</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {([1, 2] as const).map((v) => (
              <label
                key={v}
                className={cx(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors duration-150",
                  choice === v ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong",
                )}
              >
                <input type="radio" name={`${name}-vote`} className="mt-1 accent-[var(--accent)]" checked={choice === v} onChange={() => setChoice(v)} />
                <span>
                  <span className="font-medium text-ink">{v === 1 ? "Uphold" : "Reject"}</span>
                  <span className="mt-0.5 block text-xs text-muted">{v === 1 ? "The buyer is right: the description is false." : "The description holds for these tasks."}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">
            Your vote stays hidden until everyone has voted. A random secret is saved in this browser; you need it to reveal, so vote from the browser you’ll reveal from.
          </p>
          <button className="btn btn-primary" disabled={!choice || commit.busy} onClick={doCommit}>
            {commit.busy ? "Casting vote…" : "Cast hidden vote"}
          </button>
          {err && (
            <p role="alert" className="text-xs text-bad">
              {err}
            </p>
          )}
          <div aria-live="polite">
            <TxStatus state={commit.state} />
          </div>
        </fieldset>
      )}

      {committed && !seat.revealed && (
        <div className="space-y-2">
          <h3 className="text-[13px] font-medium text-ink">Reveal your vote</h3>
          {!secret ? (
            <p className="text-xs text-muted">This browser doesn’t have the secret for your vote. It was cast elsewhere, for example by the juror agent, and only that holder can reveal it.</p>
          ) : !secretMatches ? (
            <p className="text-xs text-bad">The secret saved here doesn’t match your vote on-chain, so it can’t reveal it.</p>
          ) : revealOpen ? (
            <>
              <p className="text-xs text-muted">Reveals “{secret.verdict === 1 ? "uphold" : "reject"}” using the secret saved in this browser.</p>
              <button
                className="btn btn-primary"
                disabled={reveal.busy}
                onClick={() => reveal.run("Reveal vote", { address: deployment!.market, abi: marketAbi, functionName: "revealVote", args: [d.id, secret.verdict, secret.salt] })}
              >
                {reveal.busy ? "Revealing…" : "Reveal vote"}
              </button>
              <div aria-live="polite">
                <TxStatus state={reveal.state} />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              {now > d.revealDeadline ? (
                "The reveal window has closed."
              ) : (
                <>
                  Reveals open when voting closes (<Countdown to={d.commitDeadline} />) or once all three jurors have voted.
                </>
              )}
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-muted">
        If a juror agent runs with this key, it votes on its own. Vote here only for a key no agent uses: each seat votes once, and only the browser holding the secret can reveal.
      </p>
    </section>
  );
}

function CasePacketView({ disputeId, juror }: { disputeId: bigint; juror: Address }) {
  const { signMessageAsync } = useSignMessage();
  const health = useHealth();
  const [cp, setCp] = useState<CasePacket | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pk = cp?.packet as Record<string, unknown> | undefined;
  const claims = (pk?.disputedClaims as { id: string; text: string }[] | undefined) ?? [];
  const ev = pk?.evidence as { text?: string | null; verified?: boolean } | undefined;
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-ink">Case file</h3>
          <p className="mt-0.5 text-xs text-muted">Your wallet signs a one-time message so the TEE can check your seat. It then sends the case file it signed.</p>
        </div>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              setCp(await requestCasePacket({ disputeId, juror, signMessage: (message) => signMessageAsync({ message }) }));
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : null} {busy ? "Opening…" : cp ? "Reload case file" : "Open case file"}
        </button>
      </div>
      {err && (
        <p role="alert" className="text-xs text-bad [overflow-wrap:anywhere]">
          {err}
        </p>
      )}
      {cp && pk && (
        <div className="space-y-4 text-[13px]">
          <div className="flex flex-wrap gap-1.5">
            <Verified ok={cp.hashOk && !!cp.packetSigner && eqHash(cp.packetSigner, health.data?.signer)} okText="Signed by the TEE" badText="Signature doesn’t check out" />
            {ev && <Verified ok={!!ev.verified} okText="Evidence matches the chain" badText="Evidence unverified" />}
          </div>
          {claims.length > 0 && (
            <div>
              <div className="section-title">Disputed claims</div>
              <ul className="mt-2 space-y-1.5">
                {claims.map((c) => (
                  <li key={c.id} className="flex gap-2.5">
                    <span className="shrink-0 font-mono text-xs font-medium text-accent">{c.id}</span>
                    <span className="text-ink">{c.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ev?.text && (
            <div>
              <div className="section-title">Buyer’s evidence</div>
              <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-xs whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{ev.text}</pre>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:text-ink">Full case file (bundle facts, excerpts, delivery record)</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-[11px]">{JSON.stringify(pk, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------ jury ------------------------------------ */

function JuryCard({ d, events, primary }: { d: Dispute; events: MarketEvent[]; primary: boolean }) {
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
  const allRevealed = roundSeats(d).every((s) => s.revealed);
  const canTally = voting && (now > d.revealDeadline || allRevealed);

  return (
    <Card title="Jury" subtitle="Three staked AI jurors, drawn at random. The buyer and the seller can’t sit on it.">
      <div className="space-y-6">
        {awaiting && (
          <div className="space-y-3 text-[13px]">
            <p className="text-muted">
              {d.round === 2 && "Round 1 didn’t reach a majority, so a new jury is drawn without the round 1 jurors. "}
              The jury is drawn with randomness from a block that didn’t exist when the problem was reported, so nobody can pick the jurors.{" "}
              {cur !== undefined &&
                (cur > d.selectionBlock ? "That block is mined, so anyone can draw the jury now." : `${(d.selectionBlock - cur + 1n).toString()} more block${d.selectionBlock - cur + 1n === 1n ? "" : "s"} to go.`)}
            </p>
            <p className="text-xs text-muted">If three jurors can’t be seated by {fmtTime(d.selectionDeadline)}, this round fails.</p>
            <RequireWallet why="Anyone can draw the jury. Sign in to send the transaction.">
              <button className={cx("btn", primary && "btn-primary")} disabled={!canSelect || select.busy} onClick={() => select.run("Draw the jury", { address: m, abi: marketAbi, functionName: "selectJurors", args: [d.id] })}>
                {select.busy ? "Drawing…" : "Draw the jury"}
              </button>
            </RequireWallet>
            <div aria-live="polite">
              <TxStatus state={select.state} />
            </div>
          </div>
        )}

        {rounds.map((r) => {
          const sel = selections.find((e) => Number(e.args.round) === r);
          const seats = roundSeats(d, r);
          if (!sel && seats.every((s) => isEmptyAddr(s.juror))) return null;
          const commitDl = sel ? Number(sel.args.commitDeadline) : d.commitDeadline;
          const revealDl = sel ? Number(sel.args.revealDeadline) : d.revealDeadline;
          return (
            <div key={r} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted">
                <span className="text-[13px] font-medium text-ink">{rounds.length > 1 ? `Round ${r}` : "Jurors"}</span>
                {sel && (
                  <span className="tabular-nums">
                    Vote by {fmtTime(commitDl)} · reveal by {fmtTime(revealDl)}
                  </span>
                )}
              </div>
              <ul className="divide-y divide-line rounded-md border border-line">
                {seats.map((s, i) => (
                  <SeatRow key={i} i={i} s={s} />
                ))}
              </ul>
            </div>
          );
        })}

        {voting && (
          <div className="space-y-3 border-t border-line pt-5 text-[13px]">
            <p className="text-muted">
              Anyone can count the votes after the reveal deadline, or as soon as all three are revealed. A majority of at least two revealed votes decides. Without one, jurors who didn’t reveal lose
              part of their stake and {d.round === 1 ? "a new jury is drawn" : "the dispute closes with no refund and the buyer’s deposit returned"}.
            </p>
            <RequireWallet why="Anyone can count the votes. Sign in to send the transaction.">
              <div className="flex flex-wrap items-center gap-3">
                <button className={cx("btn", primary && canTally && "btn-primary")} disabled={!canTally || tally.busy} onClick={() => tally.run("Count the votes", { address: m, abi: marketAbi, functionName: "tallyDispute", args: [d.id] })}>
                  {tally.busy ? "Counting…" : "Count the votes"}
                </button>
                {!canTally && (
                  <span className="text-xs text-muted">
                    Available in <Countdown to={d.revealDeadline} />
                  </span>
                )}
              </div>
            </RequireWallet>
            <div aria-live="polite">
              <TxStatus state={tally.state} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function SeatRow({ i, s }: { i: number; s: Seat }) {
  const empty = isEmptyAddr(s.juror);
  const committed = !isZeroHash(s.commitment);
  const status: { text: string; tone: Tone } = empty
    ? { text: "Not drawn", tone: "neutral" }
    : s.revealed
      ? s.vote === 1
        ? { text: "Voted to uphold", tone: "ok" }
        : { text: "Voted to reject", tone: "info" }
      : committed
        ? { text: "Voted (hidden)", tone: "accent" }
        : { text: "Waiting", tone: "neutral" };
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
      <span className="text-ink">Juror {i + 1}</span>
      <span className="flex items-center gap-3">
        {s.reward > 0n && <span className="font-mono text-xs text-ok tabular-nums">+{fmtUsdc(s.reward, { symbol: false })}</span>}
        {s.slashed > 0n && <span className="font-mono text-xs text-bad tabular-nums">−{fmtUsdc(s.slashed, { symbol: false })}</span>}
        <Chip tone={status.tone} dot>
          {status.text}
        </Chip>
      </span>
    </li>
  );
}

/** Jury randomness and per-seat addresses and transactions, for the Details panel. */
function JuryDetails({ d, events }: { d: Dispute; events: MarketEvent[] }) {
  const selections = events.filter((e) => e.eventName === "JurorsSelected");
  const rounds = [1, 2].filter((r) => selections.some((e) => Number(e.args.round) === r) || roundSeats(d, r).some((s) => !isEmptyAddr(s.juror)));
  const selUrl = blockUrl(d.selectionBlock);
  return (
    <>
      <DetailSection title="Jury draw" hint="Seats come from keccak256(blockhash(selectionBlock), prevrandao, disputeId, round). On Base a single sequencer produces blocks and could in principle bias this.">
        <dl className="kv">
          <dt>Selection block</dt>
          <dd className="font-mono tabular-nums">
            {selUrl ? (
              <a href={selUrl} target="_blank" rel="noreferrer" className="link">
                {d.selectionBlock.toString()}
              </a>
            ) : (
              d.selectionBlock.toString()
            )}
          </dd>
          {selections.map((sel) => (
            <SelectionRow key={sel.transactionHash} sel={sel} />
          ))}
        </dl>
      </DetailSection>
      {rounds.length > 0 && (
        <DetailSection title="Jurors">
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="data-table min-w-[520px]">
              <thead>
                <tr>
                  <th scope="col">Seat</th>
                  <th scope="col">Address</th>
                  <th scope="col">Vote tx</th>
                  <th scope="col">Reveal tx</th>
                </tr>
              </thead>
              <tbody>
                {rounds.flatMap((r) =>
                  roundSeats(d, r).map((s, i) => {
                    const lc = s.juror.toLowerCase();
                    const commitEv = events.find((e) => e.eventName === "VoteCommitted" && Number(e.args.round) === r && String(e.args.juror).toLowerCase() === lc);
                    const revealEv = events.find((e) => e.eventName === "VoteRevealed" && Number(e.args.round) === r && String(e.args.juror).toLowerCase() === lc);
                    return (
                      <tr key={`${r}-${i}`}>
                        <td className="text-muted">
                          {rounds.length > 1 ? `R${r} · ` : ""}Juror {i + 1}
                        </td>
                        <td>{isEmptyAddr(s.juror) ? <span className="text-faint">not drawn</span> : <AddressLink address={s.juror} />}</td>
                        <td>{commitEv ? <TxLink hash={commitEv.transactionHash} /> : <span className="text-faint">—</span>}</td>
                        <td>{revealEv ? <TxLink hash={revealEv.transactionHash} /> : <span className="text-faint">—</span>}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </DetailSection>
      )}
    </>
  );
}

function SelectionRow({ sel }: { sel: MarketEvent }) {
  return (
    <>
      <dt>Round {String(sel.args.round)} seed</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <HashValue value={String(sel.args.seed ?? "")} />
        <TxLink hash={sel.transactionHash} label="draw tx" />
      </dd>
    </>
  );
}

/* ------------------------------ published rationales ------------------------------ */

const ratKey = (id: bigint) => `envmarket.rationales.${CHAIN_ID}.${deployment?.market.toLowerCase()}.${id}`;

/**
 * Juror agents publish a screened rationale (envmarket.juror-rationale.v1) to the TEE's
 * content-addressed blob store after their own reveal, and log its sha256. There is no on-chain
 * pointer, so a rationale is looked up by that hash and checked against the chain here: same
 * chain/market/dispute, a seat in that round, the revealed vote and the seat's commitment.
 */
function RationalesSection({ d }: { d: Dispute }) {
  const [hashes, setHashes] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const inputId = useId();
  // eslint-disable-next-line react-hooks/set-state-in-effect -- remembered hashes live in localStorage
  useEffect(() => setHashes(JSON.parse((typeof window !== "undefined" && window.localStorage.getItem(ratKey(d.id))) || "[]")), [d.id]);
  const anyRevealed = d.seats.some((s) => s.revealed);
  if (!anyRevealed && !hashes.length) return null;
  function add() {
    const m = input.match(/(?:0x)?([0-9a-fA-F]{64})/);
    if (!m) {
      setErr("Paste the explanation’s sha256 (64 hex characters) or its /blobs/ URL.");
      return;
    }
    const h = `0x${m[1].toLowerCase()}`;
    const next = [...new Set([...hashes, h])];
    setHashes(next);
    window.localStorage.setItem(ratKey(d.id), JSON.stringify(next));
    setInput("");
    setErr(null);
  }
  return (
    <DetailSection title="Juror explanations" hint="Each juror agent publishes a screened explanation after its own reveal, never before, so it can’t leak a hidden vote. There is no on-chain pointer yet: the agent logs the file’s sha256 when it uploads.">
      <div className="space-y-3">
        {hashes.map((h) => (
          <RationaleItem key={h} hash={h as Hex} d={d} />
        ))}
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label htmlFor={inputId} className="block text-xs text-muted">
            Explanation sha256 or blob URL, from the juror’s log
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              name="rationale-hash"
              autoComplete="off"
              spellCheck={false}
              className="input font-mono"
              placeholder="0x… or https://…/blobs/…"
              value={input}
              aria-invalid={!!err}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" className="btn shrink-0" disabled={!input}>
              Check and show
            </button>
          </div>
          {err && (
            <p role="alert" className="text-xs text-bad">
              {err}
            </p>
          )}
        </form>
      </div>
    </DetailSection>
  );
}

function RationaleItem({ hash, d }: { hash: Hex; d: Dispute }) {
  const q = useQuery({ queryKey: ["rationale", hash], queryFn: () => fetchRationale(hash), staleTime: Infinity, retry: 0 });
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.error || !q.data) return <Notice tone="bad">{(q.error as Error)?.message ?? "Not found in the blob store. Check the hash and try again."}</Notice>;
  const r: RationaleDoc = q.data.doc;
  const seats = roundSeats(d, r.round);
  const seat = seats.find((s) => s.juror.toLowerCase() === r.juror.toLowerCase());
  const checks: [string, boolean][] = [
    ["sha256 matches", q.data.hashOk],
    ["this chain, market and dispute", r.chainId === CHAIN_ID && eqHash(r.market, deployment?.market) && r.disputeId === d.id.toString()],
    [`juror seated in round ${r.round}`, !!seat],
    ["verdict = revealed on-chain vote", !!seat && seat.revealed && (seat.vote === 1 ? "Uphold" : "Reject") === r.verdict],
    ["commitment = seat commitment", !!seat && eqHash(seat.commitment, r.commitment)],
  ];
  return (
    <div className="space-y-2 rounded-md border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <AddressLink address={r.juror} />
        <Chip tone={r.verdict === "Uphold" ? "ok" : "info"}>{r.verdict}</Chip>
        <span className="text-xs text-muted">
          round {r.round} · confidence {r.confidence} · {r.model?.resolved ?? r.model?.requested ?? "model unknown"} · prompt {r.promptVersion}
        </span>
      </div>
      <p className="leading-relaxed text-ink">{r.rationale}</p>
      {r.citedFacts.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {r.citedFacts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        {checks.map(([label, ok]) => (
          <Verified key={label} ok={ok} okText={label} badText={label} />
        ))}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span>
          case file sha256 <HashValue value={r.packetSha256} />
        </span>
        <span>
          reveal <TxLink hash={r.revealTx} />
        </span>
        <a className="link" href={q.data.url} target="_blank" rel="noreferrer">
          raw
        </a>
      </p>
    </div>
  );
}

/* ---------------------------------- outcome ---------------------------------- */

function OutcomeCard({ d, p }: { d: Dispute; p: Purchase }) {
  const upheld = d.verdict === 1;
  const o = outcomeLabel(d);
  const jurorPaid = d.seats.reduce((a, s) => a + s.reward, 0n);
  const jurorSlashed = d.seats.reduce((a, s) => a + s.slashed, 0n);
  const confirmed = maskToIndexes(d.confirmedMask).map((i) => i + 1);
  const rows: [string, bigint, string][] = [
    ["Refund to the buyer", d.refund, upheld ? `${confirmed.length} confirmed task${confirmed.length === 1 ? "" : "s"} at the per-task price, within the cap` : "none"],
    ["Buyer’s deposit", d.bond, upheld || d.fallbackNoQuorum ? "returned in full" : "case fee taken from it, the rest goes to a neutral reserve"],
    ["Seller receives", p.sellerProceeds, "what the buyer paid, less refund and market fee"],
    ["Market fee", p.fee, "to the treasury"],
    ["Seller penalty", p.penalties, "taken from the seller’s collateral into the reserve"],
    ["Case fee", d.caseFee, upheld ? "paid from the seller’s collateral" : d.fallbackNoQuorum ? "not charged" : "paid from the buyer’s deposit"],
  ];
  if (!isMechanical(d.ground)) {
    rows.push(["Paid to jurors", jurorPaid, "revealing jurors and the majority"]);
    rows.push(["Taken from jurors", jurorSlashed, "minority votes and jurors who didn’t reveal"]);
  }
  return (
    <Card title="Outcome" subtitle={`Decided ${fmtTime(d.resolvedAt)}. Each party withdraws its share from its market balance.`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip tone={o.tone} dot>
          {o.text}
        </Chip>
        {upheld && confirmed.length > 0 && <span className="text-[13px] text-muted">Confirmed defects: {confirmed.map((i) => `task ${i}`).join(", ")}</span>}
        {d.fallbackNoQuorum && <span className="text-[13px] text-muted">Closed with the agreed no-fault outcome.</span>}
      </div>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([k, v, hint]) => (
          <div key={k} className="flex items-start justify-between gap-4 py-2.5">
            <dt className="min-w-0">
              <span className="text-ink">{k}</span>
              <span className="mt-0.5 block text-xs text-muted">{hint}</span>
            </dt>
            <dd className="shrink-0 font-mono tabular-nums text-ink">{fmtUsdc(v)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

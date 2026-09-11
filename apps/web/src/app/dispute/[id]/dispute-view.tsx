"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import { AddressLink, Card, Countdown, Empty, HashValue, Notice, Skeleton, Spinner, Verified, cx, useNow, TxLink } from "@/components/ui";
import { marketAbi } from "@/lib/abi";
import { blockUrl, CHAIN_ID, deployment } from "@/lib/config";
import { useHealth } from "@/lib/docs";
import { fmtTime, fmtUsdc, maskToIndexes, pct } from "@/lib/format";
import {
  DISPUTE_STATUS,
  GROUND_HELP,
  GROUND_LABEL,
  VERDICTS,
  eventsForDispute,
  isMechanical,
  isZeroHash,
  readOptional,
  useBlockNumber,
  useDispute,
  useMarketEvents,
  usePurchase,
  type Dispute,
  type Purchase,
  type Seat,
} from "@/lib/market";
import type { MarketEvent } from "@/lib/client";
import { eqHash, sha256Hex } from "@/lib/crypto";
import { fetchBlob, fetchRationale, getFindings, loadLocalEvidence, requestCasePacket, type CasePacket, type RationaleDoc } from "@/lib/tee";
import { ClaimBanner, StateBadge } from "../../purchase/[id]/purchase-view";

function parseId(id: string): bigint | null {
  return /^\d+$/.test(id) && id.length < 30 ? BigInt(id) : null;
}

const isEmptyAddr = (a: string) => /^0x0+$/.test(a);

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
          {isMechanical(d.ground) ? (
            <>
              <MechanicalCard d={d} events={mine} />
              <FindingsCard d={d} />
            </>
          ) : (
            <>
              <MyJurySeat d={d} />
              <JuryCard d={d} events={mine} />
              <RationalesCard d={d} />
            </>
          )}
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
  const [local, setLocal] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage only exists client-side
  useEffect(() => setLocal(loadLocalEvidence(d.id)), [d.id]);
  const localOk = local !== null && eqHash(sha256Hex(local), d.evidenceHash);
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
        {localOk ? (
          <div className="mt-2 rounded-lg border border-line bg-panel-2 p-3">
            <div className="mb-1 text-[11px] text-muted">✓ your copy, kept in this browser; matches the on-chain evidenceHash. Seated jurors receive it inside the TEE’s case packet.</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{local}</pre>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">
            The evidence is private: the buyer uploaded it to the TEE, which gives it only to seated jurors (inside a signed case packet) and to the mechanical verifier. Only its hash is public.
          </p>
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
          <p className="flex items-start gap-2 text-muted">
            <Spinner className="mt-0.5 h-3.5 w-3.5 shrink-0" />
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

/** Public findings JSON (aggregates only) from the TEE; its sha256 is the on-chain findingsHash. */
function FindingsCard({ d }: { d: Dispute }) {
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
  if (q.isLoading) return null;
  if (!q.data) return d.status === 3 ? null : null;
  const f = q.data.findings as Record<string, unknown>;
  const onChain = !isZeroHash(d.findingsHash);
  return (
    <Card
      title="Verifier findings"
      subtitle={`Published by the TEE (${q.data.source}); aggregates only, no audit data.`}
      action={onChain ? <Verified ok={eqHash(q.data.computed, d.findingsHash)} okText="sha256 = on-chain findingsHash" badText="hash ≠ on-chain" /> : <span className="badge badge-neutral">not on-chain yet</span>}
    >
      <dl className="kv text-sm">
        <dt>Result</dt>
        <dd>{f.upheld ? "upheld" : "rejected"} · confirmed tasks {maskToIndexes(BigInt(String(f.confirmedMask ?? "0"))).map((i) => `#${i + 1}`).join(", ") || "none"}</dd>
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
        <summary className="cursor-pointer text-xs text-accent">Full findings JSON</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-panel-2 p-3 text-[11px]">{JSON.stringify(f, null, 2)}</pre>
      </details>
    </Card>
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
 * If the connected wallet holds a seat in the current round: its commit/reveal status, the TEE case
 * packet (signed challenge), and a manual commit → reveal with the salt kept in this browser. This
 * is an alternative to running the juror agent for that key — don't do both for the same juror.
 */
function MyJurySeat({ d }: { d: Dispute }) {
  const { address } = useAccount();
  const now = useNow();
  const commit = useTx();
  const reveal = useTx();
  const [secret, setSecret] = useState<VoteSecret | null>(null);
  const [choice, setChoice] = useState<1 | 2 | 0>(0);
  const [err, setErr] = useState<string | null>(null);
  const roundSeats = d.seats.slice((d.round - 1) * 3, d.round * 3);
  const seat = address ? roundSeats.find((s) => s.juror.toLowerCase() === address.toLowerCase()) : undefined;
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the vote secret lives in localStorage
  useEffect(() => setSecret(address && seat ? loadSecret(d.id, d.round, address) : null), [address, seat, d.id, d.round]);
  if (!address || !seat || d.status !== 2) return null;

  const committed = !isZeroHash(seat.commitment);
  const allCommitted = roundSeats.every((s) => !isZeroHash(s.commitment));
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
      setErr("The contract computes a different commitment; not committing.");
      return;
    }
    // persist BEFORE sending: losing the salt means you cannot reveal and your stake is slashed
    const s = { verdict: choice, salt, commitment };
    saveSecret(d.id, d.round, address, s);
    setSecret(s);
    await commit.run("Commit vote", { address: deployment!.market, abi: marketAbi, functionName: "commitVote", args: [d.id, commitment] });
  }

  return (
    <Card title={`Your seat · round ${d.round}`} subtitle="You are drawn on this panel. Read the case packet, then commit a sealed vote and reveal it.">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <span className={cx("badge", committed ? "badge-ok" : "badge-warn")}>{committed ? "committed" : "not committed"}</span>
          <span className={cx("badge", seat.revealed ? "badge-ok" : "badge-neutral")}>{seat.revealed ? `revealed: ${seat.vote === 1 ? "Uphold" : "Reject"}` : "not revealed"}</span>
          <span className="text-xs text-muted">
            commit by {fmtTime(d.commitDeadline)} · reveal by {fmtTime(d.revealDeadline)}
          </span>
        </div>
        <Notice tone="neutral">
          If a juror agent (services/jurors) runs with this key it votes by itself. Vote manually only for a key no agent is using: each seat can commit once, and only the holder of the salt can reveal.
        </Notice>

        <CasePacketView disputeId={d.id} juror={address} />

        {commitOpen && (
          <div className="rounded-lg border border-line p-3">
            <div className="font-medium">Commit a sealed vote</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {([1, 2] as const).map((v) => (
                <label key={v} className={cx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5", choice === v ? "border-accent bg-accent-soft" : "border-line")}>
                  <input type="radio" checked={choice === v} onChange={() => setChoice(v)} />
                  {v === 1 ? "Uphold (the claim is false)" : "Reject (the description holds)"}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">A random 32-byte salt is generated and kept in this browser’s localStorage; the chain only sees keccak256(disputeId, round, verdict, salt, you).</p>
            <button className="btn btn-primary btn-sm mt-2" disabled={!choice || commit.busy} onClick={doCommit}>
              Commit vote
            </button>
            {err && <p className="mt-1 text-xs text-bad">{err}</p>}
            <TxStatus state={commit.state} />
          </div>
        )}

        {committed && !seat.revealed && (
          <div className="rounded-lg border border-line p-3">
            <div className="font-medium">Reveal</div>
            {!secret ? (
              <p className="mt-1 text-xs text-muted">This browser has no salt for your commitment (committed elsewhere, e.g. by the juror agent). Only the holder of the salt can reveal.</p>
            ) : !secretMatches ? (
              <p className="mt-1 text-xs text-bad">The salt stored here does not match your on-chain commitment.</p>
            ) : revealOpen ? (
              <>
                <p className="mt-1 text-xs text-muted">Reveals {secret.verdict === 1 ? "Uphold" : "Reject"} with the stored salt.</p>
                <button className="btn btn-primary btn-sm mt-2" disabled={reveal.busy} onClick={() => reveal.run("Reveal vote", { address: deployment!.market, abi: marketAbi, functionName: "revealVote", args: [d.id, secret.verdict, secret.salt] })}>
                  Reveal vote
                </button>
                <TxStatus state={reveal.state} />
              </>
            ) : (
              <p className="mt-1 text-xs text-muted">
                {now > d.revealDeadline ? "The reveal window has closed." : <>Reveal opens when the commit window closes (<Countdown to={d.commitDeadline} />) or once all three seats have committed.</>}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
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
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">Case packet</div>
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
          {busy ? <Spinner className="h-3.5 w-3.5" /> : null} {cp ? "Fetch again" : "Sign challenge & fetch"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">Your wallet signs a one-time EIP-191 challenge; the TEE checks you hold a seat on the current round and returns the packet it signed.</p>
      {err && <p className="mt-2 break-words text-xs text-bad">{err}</p>}
      {cp && pk && (
        <div className="mt-3 space-y-3 text-xs">
          <div className="flex flex-wrap gap-1.5">
            <Verified ok={cp.hashOk} okText="sha256 = packetHash" badText="packet hash mismatch" />
            <Verified ok={!!cp.packetSigner && eqHash(cp.packetSigner, health.data?.signer)} okText="signed by the TEE signer" badText="signer ≠ TEE" />
            {ev && <Verified ok={!!ev.verified} okText="evidence = on-chain hash" badText="evidence unverified" />}
          </div>
          {claims.length > 0 && (
            <div>
              <div className="section-title">Disputed claims (frozen description)</div>
              <ul className="mt-1 space-y-1">
                {claims.map((c) => (
                  <li key={c.id} className="rounded border border-line px-2 py-1">
                    <span className="font-mono font-semibold text-accent">{c.id}</span> {c.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ev?.text && (
            <div>
              <div className="section-title">Buyer evidence</div>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-panel-2 p-2">{ev.text}</pre>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-accent">Full packet (bundle facts, excerpts, delivery record)</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-panel-2 p-2 text-[11px]">{JSON.stringify(pk, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
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
    <Card title="AI jury (commit–reveal)" subtitle="Three approved, staked jurors are drawn at random, excluding the buyer and seller. Votes are sealed, then revealed.">
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
            <p className="mt-1 text-xs text-muted">If three eligible jurors can’t be seated by {fmtTime(d.selectionDeadline)}, the round counts as failed (selecting after that records the failure).</p>
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
          if (!sel && seats.every((s) => isEmptyAddr(s.juror))) return null;
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
          Juror economics (snapshotted): stake {fmtUsdc(d.jurorStake)} locked per seat; each revealing juror earns up to {fmtUsdc(d.participationFee)} from the case fee; the rest plus {pct(d.minoritySlashBps)} of each
          minority seat’s stake goes to the majority; non-revealers lose {pct(d.nonRevealSlashBps)} of their stake to the reserve. Agreement with the majority does not establish truth; jurors may share a base
          model’s mistakes.
        </p>
      </div>
    </Card>
  );
}

function SeatRow({ i, s, events, round }: { i: number; s: Seat; events: MarketEvent[]; round: number }) {
  const empty = isEmptyAddr(s.juror);
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

/* ------------------------------ published rationales ------------------------------ */

const ratKey = (id: bigint) => `envmarket.rationales.${CHAIN_ID}.${deployment?.market.toLowerCase()}.${id}`;

/**
 * Juror agents publish a screened rationale (envmarket.juror-rationale.v1) to the TEE's
 * content-addressed blob store after their own reveal, and log its sha256. There is no on-chain
 * pointer, so a rationale is looked up by that hash and checked against the chain here: same
 * chain/market/dispute, a seat in that round, the revealed vote and the seat's commitment.
 */
function RationalesCard({ d }: { d: Dispute }) {
  const [hashes, setHashes] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- remembered hashes live in localStorage
  useEffect(() => setHashes(JSON.parse((typeof window !== "undefined" && window.localStorage.getItem(ratKey(d.id))) || "[]")), [d.id]);
  const anyRevealed = d.seats.some((s) => s.revealed);
  if (!anyRevealed && !hashes.length) return null;
  function add() {
    const m = input.match(/(?:0x)?([0-9a-fA-F]{64})/);
    if (!m) {
      setErr("Paste the rationale’s sha256 (64 hex) or its /blobs/ URL.");
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
    <Card title="Published juror rationales" subtitle="Each juror agent publishes its screened rationale after its own reveal (never before, so it can’t leak a sealed vote).">
      <div className="space-y-3">
        {hashes.map((h) => (
          <RationaleItem key={h} hash={h as Hex} d={d} />
        ))}
        <div className="flex gap-2">
          <input className="input font-mono text-xs" placeholder="rationale sha256 or blob URL (from the juror’s log)" value={input} onChange={(e) => setInput(e.target.value)} />
          <button className="btn btn-sm shrink-0" onClick={add} disabled={!input}>
            Verify & show
          </button>
        </div>
        {err && <p className="text-xs text-bad">{err}</p>}
        <p className="text-xs text-muted">
          Rationales have no on-chain pointer yet: a juror agent logs “published rationale … sha256 0x…” when it uploads one. The document is fetched from the TEE blob store and checked against the chain below.
        </p>
      </div>
    </Card>
  );
}

function RationaleItem({ hash, d }: { hash: Hex; d: Dispute }) {
  const q = useQuery({ queryKey: ["rationale", hash], queryFn: () => fetchRationale(hash), staleTime: Infinity, retry: 0 });
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.error || !q.data) return <Notice tone="bad">{(q.error as Error)?.message ?? "not found"}</Notice>;
  const r: RationaleDoc = q.data.doc;
  const seats = d.seats.slice((r.round - 1) * 3, r.round * 3);
  const seat = seats.find((s) => s.juror.toLowerCase() === r.juror.toLowerCase());
  const checks: [string, boolean][] = [
    ["sha256 matches", q.data.hashOk],
    ["this chain, market and dispute", r.chainId === CHAIN_ID && eqHash(r.market, deployment?.market) && r.disputeId === d.id.toString()],
    [`juror seated in round ${r.round}`, !!seat],
    ["verdict = revealed on-chain vote", !!seat && seat.revealed && (seat.vote === 1 ? "Uphold" : "Reject") === r.verdict],
    ["commitment = seat commitment", !!seat && eqHash(seat.commitment, r.commitment)],
  ];
  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <AddressLink address={r.juror} />
        <span className={cx("badge", r.verdict === "Uphold" ? "badge-ok" : "badge-bad")}>{r.verdict}</span>
        <span className="text-xs text-muted">
          round {r.round} · confidence {r.confidence} · {r.model?.resolved ?? r.model?.requested ?? "model ?"} · prompt {r.promptVersion}
        </span>
      </div>
      <p className="mt-2 leading-relaxed">{r.rationale}</p>
      {r.citedFacts.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
          {r.citedFacts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {checks.map(([label, ok]) => (
          <Verified key={label} ok={ok} okText={label} badText={`✗ ${label}`} />
        ))}
      </div>
      <p className="mt-1 text-[11px] text-muted">
        packet sha256 <HashValue value={r.packetSha256} /> · reveal <TxLink hash={r.revealTx} /> ·{" "}
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
    <Card title="Outcome & settlement" subtitle={`Resolved ${fmtTime(d.resolvedAt)}. All payouts are credited as claimable balances and withdrawn by each party.`}>
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

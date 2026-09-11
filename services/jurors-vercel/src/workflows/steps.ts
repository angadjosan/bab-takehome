/**
 * Durable workflow steps: every chain read, LLM call, TEE call and transaction. Each step
 * re-reads on-chain state before acting (so a retried or replayed step is a no-op when its effect
 * already landed), uses exactly one juror key, and waits for its receipt. Expected failures are
 * returned as { ok: false } instead of thrown, so the workflow loop decides what to do next.
 *
 * Nothing here logs or returns a private key or a salt. Verdicts are only in step results (the
 * workflow event log, visible to members of the Vercel project) and never in runtime logs before
 * the reveal.
 */
import type { Address, Hex } from 'viem';
import { jurorAddresses, jurorClients, jurorKey, loadConfig, publicClientFor, type ServiceConfig } from '../lib/config.ts';
import { deriveVoteSalt, recoverVerdict } from '../lib/salt.ts';
import { DisputeStatus, Ground, SEATS, ZERO32, type ActionResult, type DecisionRecord, type Snapshot, type Verdict } from '../lib/types.ts';
import { commitmentOf, VERDICT_CODE } from '../vendor/jurors/src/commit.ts';
import { decide } from '../vendor/jurors/src/decide.ts';
import { fetchCasePacket } from '../vendor/jurors/src/evidence.ts';
import { resolveJurorLlm } from '../vendor/jurors/src/llm.ts';
import { MarketIO, type DisputeView, type SeatView } from '../vendor/jurors/src/market.ts';
import { buildRationaleDoc, canonical, postRationale, putBlob } from '../vendor/jurors/src/publish.ts';
import { parseRubric } from '../vendor/jurors/src/rubric.ts';
import type { Decision } from '../vendor/jurors/src/state.ts';
import { PROMPT_TEXT } from '../vendor/prompt-text.ts';

const log = (line: string) => console.log(`[jurors] ${line}`);
const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0]!.slice(0, 300);

function ctx(jurorIndex: number) {
  const cfg = loadConfig();
  const clients = jurorClients(jurorIndex, cfg);
  return { cfg, clients, io: new MarketIO(clients, cfg.market), me: clients.account.address };
}

function disabled(kind: ActionResult['kind'], cfg: ServiceConfig): ActionResult | null {
  return cfg.enabled ? null : { ok: false, kind, reason: 'disabled (JURORS_ENABLED is not 1)', retryable: false };
}

function panelSeat(d: DisputeView, seats: SeatView[], round: number, me: Address): SeatView | undefined {
  return seats.slice((round - 1) * SEATS, round * SEATS).find((s) => s.juror.toLowerCase() === me.toLowerCase());
}

function saltFor(cfg: ServiceConfig, jurorIndex: number, disputeId: bigint, round: number, juror: Address): Hex {
  return deriveVoteSalt(jurorKey(jurorIndex), { chainId: cfg.chainId, market: cfg.market, disputeId, round, juror });
}

// ------------------------------------------------------------------ reads

export async function readSnapshot(disputeId: string): Promise<Snapshot> {
  'use step';
  const cfg = loadConfig();
  const pc = publicClientFor(cfg);
  const { io } = ctx(cfg.keeperIndex);
  const id = BigInt(disputeId);
  const [block, got, jurors] = await Promise.all([
    pc.getBlock({ blockTag: 'latest' }),
    io.getDispute(id),
    Promise.all(jurorAddresses().map(async (j) => ({ ...j, claimable: await io.claimable(j.address) }))),
  ]);
  const { d, seats } = got;
  return {
    disputeId,
    head: { number: block.number, timestamp: block.timestamp },
    enabled: cfg.enabled,
    keeperIndex: cfg.keeperIndex,
    dispute: {
      purchaseId: d.purchaseId,
      ground: d.ground,
      status: d.status,
      verdict: d.verdict,
      round: d.round,
      fallbackNoQuorum: d.fallbackNoQuorum,
      selectionBlock: BigInt(d.selectionBlock),
      selectionDeadline: BigInt(d.selectionDeadline),
      commitDeadline: BigInt(d.commitDeadline),
      revealDeadline: BigInt(d.revealDeadline),
    },
    seats: seats.map((s) => ({ juror: s.juror, vote: Number(s.vote), revealed: s.revealed, commitment: s.commitment })),
    jurors,
  };
}
readSnapshot.maxRetries = 3;

// ------------------------------------------------------------------ keeper

async function keeperSend(kind: 'select' | 'tally', fn: 'selectJurors' | 'tallyDispute', disputeId: string, jurorIndex: number): Promise<ActionResult> {
  const { cfg, io } = ctx(jurorIndex);
  const off = disabled(kind, cfg);
  if (off) return off;
  const r = await io.send(fn, [BigInt(disputeId)]);
  if (r.ok) {
    log(`dispute #${disputeId}: keeper ${fn} -> ${r.hash}`);
    return { ok: true, kind, hash: r.hash };
  }
  return { ok: false, kind, reason: r.reason, retryable: true };
}

export async function keeperSelect(disputeId: string, jurorIndex: number): Promise<ActionResult> {
  'use step';
  return keeperSend('select', 'selectJurors', disputeId, jurorIndex);
}
keeperSelect.maxRetries = 2;

export async function keeperTally(disputeId: string, jurorIndex: number): Promise<ActionResult> {
  'use step';
  return keeperSend('tally', 'tallyDispute', disputeId, jurorIndex);
}
keeperTally.maxRetries = 2;

// ------------------------------------------------------------------ deliberation

/** Same trusted on-chain facts the reference juror process gives the model (services/jurors juror.ts). */
async function chainFacts(io: MarketIO, cfg: ServiceConfig, id: bigint, round: number, d: DisputeView) {
  const p = await io.read<{ versionId: bigint; taskCount: number }>('getPurchase', [d.purchaseId]);
  const v = await io.read<{ descriptionHash: Hex }>('getVersion', [p.versionId]);
  const taskCount = Number(p.taskCount);
  const disputed: number[] = [];
  for (let i = 0; i < taskCount; i++) if ((d.taskMask >> BigInt(i)) & 1n) disputed.push(i);
  return {
    chainId: cfg.chainId,
    market: cfg.market,
    disputeId: id.toString(),
    round,
    ground: 'FalseDescription (a specific claim in the frozen description is false)',
    purchaseId: d.purchaseId.toString(),
    versionId: p.versionId.toString(),
    frozenDescriptionHash: v.descriptionHash,
    taskCount,
    disputedTaskIndices: disputed,
    requestedRefund: (Number(d.requested) / 1e6).toString(),
    buyerEvidenceHash: d.evidenceHash,
  };
}

export async function deliberate(disputeId: string, round: number, jurorIndex: number, commitDeadline: bigint): Promise<ActionResult> {
  'use step';
  const kind = 'deliberate';
  const { cfg, clients, io, me } = ctx(jurorIndex);
  const off = disabled(kind, cfg);
  if (off) return off;
  if (!process.env.FIREWORKS_API_KEY && !process.env.LLM_BASE_URL) return { ok: false, kind, reason: 'no inference provider configured (FIREWORKS_API_KEY)', retryable: false };
  const id = BigInt(disputeId);
  const { d, seats } = await io.getDispute(id);
  const seat = panelSeat(d, seats, round, me);
  if (d.status !== DisputeStatus.Voting || d.round !== round || !seat || seat.commitment !== ZERO32) {
    return { ok: false, kind, reason: 'no longer needed (not seated, already committed, or round moved on)', retryable: false };
  }
  let packet;
  try {
    packet = await fetchCasePacket({ teeUrl: cfg.teeUrl, chainId: cfg.chainId, market: cfg.market, disputeId: id, account: clients.account, timeoutMs: 45_000 });
  } catch (e) {
    return { ok: false, kind, reason: `evidence not available yet: ${errMsg(e)}`, retryable: true };
  }
  const head = await io.head();
  // Leave time to commit: stop deliberating ~12 s before the commit deadline (and within the 300 s step limit).
  const budgetMs = Math.max(20_000, Math.min(270_000, (Number(commitDeadline - head.timestamp) - 12) * 1000));
  const deadline = AbortSignal.timeout(budgetMs);
  const resolved = await resolveJurorLlm(jurorIndex, process.env);
  const client = resolved.client.with({
    timeoutMs: budgetMs,
    retries: 1,
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline })) as typeof fetch,
  });
  const llm = { ...resolved, client };
  const t0 = Date.now();
  let decision: Decision;
  try {
    decision = await decide({
      rubric: parseRubric(PROMPT_TEXT),
      llm,
      chainFacts: await chainFacts(io, cfg, id, round, d),
      packet: packet.packet,
      packetText: packet.packetText,
      packetSha256: packet.packetSha256,
      log: (l) => log(`dispute #${disputeId} juror${jurorIndex}: ${l}`),
    });
  } catch (e) {
    return { ok: false, kind, reason: `deliberation failed: ${errMsg(e)}`, retryable: true };
  }
  log(
    `dispute #${disputeId} juror${jurorIndex} round ${round}: decided in ${((Date.now() - t0) / 1000).toFixed(1)}s by ${decision.model.served} (packet ${packet.packetSha256}); verdict kept secret until reveal`,
  );
  const rec: DecisionRecord = { verdict: decision.output.verdict, decision };
  return { ok: true, kind, decision: rec, note: `model ${decision.model.served}` };
}
deliberate.maxRetries = 0; // the loop retries (bounded) with fresh deadlines instead

// ------------------------------------------------------------------ commit-reveal

/**
 * Fix the vote before any commit tx: verdict + commitment are recorded in this step's result (the
 * workflow event log) before the commit step runs. The salt itself is re-derived from the key when
 * needed and never stored or returned.
 */
export async function prepareVote(disputeId: string, round: number, jurorIndex: number, verdict: Verdict): Promise<ActionResult> {
  'use step';
  const { cfg, me } = ctx(jurorIndex);
  const id = BigInt(disputeId);
  const commitment = commitmentOf({ disputeId: id, round, verdict, salt: saltFor(cfg, jurorIndex, id, round, me), juror: me });
  return { ok: true, kind: 'prepare', verdict, commitment };
}

export async function commitVote(disputeId: string, round: number, jurorIndex: number, verdict: Verdict, expected: Hex): Promise<ActionResult> {
  'use step';
  const kind = 'commit';
  const { cfg, io, me } = ctx(jurorIndex);
  const off = disabled(kind, cfg);
  if (off) return off;
  const id = BigInt(disputeId);
  const { d, seats } = await io.getDispute(id);
  const seat = panelSeat(d, seats, round, me);
  if (!seat || d.round !== round) return { ok: false, kind, reason: `not seated in round ${round}`, retryable: false };
  if (seat.commitment !== ZERO32) {
    // Already on-chain (an earlier attempt landed): never send a second commit.
    return seat.commitment.toLowerCase() === expected.toLowerCase()
      ? { ok: true, kind, note: 'already committed' }
      : { ok: false, kind, reason: 'seat already holds a different commitment', retryable: false };
  }
  const commitment = commitmentOf({ disputeId: id, round, verdict, salt: saltFor(cfg, jurorIndex, id, round, me), juror: me });
  if (commitment.toLowerCase() !== expected.toLowerCase()) return { ok: false, kind, reason: 'derived commitment differs from the prepared one', retryable: false };
  const r = await io.send('commitVote', [id, commitment]);
  if (!r.ok) {
    // A concurrent attempt may have landed between the read and the send.
    const again = panelSeat(d, (await io.getDispute(id)).seats, round, me);
    if (again && again.commitment.toLowerCase() === expected.toLowerCase()) return { ok: true, kind, note: 'already committed' };
    return { ok: false, kind, reason: r.reason, retryable: true };
  }
  log(`dispute #${disputeId} juror${jurorIndex} round ${round}: committed -> ${r.hash}`);
  return { ok: true, kind, hash: r.hash };
}
commitVote.maxRetries = 2;

export async function revealVote(disputeId: string, round: number, jurorIndex: number, preferred: Verdict | null): Promise<ActionResult> {
  'use step';
  const kind = 'reveal';
  const { cfg, io, me } = ctx(jurorIndex);
  const off = disabled(kind, cfg);
  if (off) return off;
  const id = BigInt(disputeId);
  const { d, seats } = await io.getDispute(id);
  const seat = panelSeat(d, seats, round, me);
  if (!seat || seat.commitment === ZERO32) return { ok: false, kind, reason: 'nothing committed', retryable: false };
  if (seat.revealed) return { ok: true, kind, note: 'already revealed', verdict: seat.vote === 1 ? 'Uphold' : 'Reject' };
  const salt = saltFor(cfg, jurorIndex, id, round, me);
  const verdict = recoverVerdict(seat.commitment, { disputeId: id, round, salt, juror: me }, preferred ?? undefined);
  if (!verdict) return { ok: false, kind, reason: 'on-chain commitment was not made with this service’s derived salt (committed by another juror process?)', retryable: false };
  const r = await io.send('revealVote', [id, VERDICT_CODE[verdict], salt]);
  if (!r.ok) {
    const again = panelSeat(d, (await io.getDispute(id)).seats, round, me);
    if (again?.revealed) return { ok: true, kind, note: 'already revealed', verdict };
    return { ok: false, kind, reason: r.reason, retryable: true };
  }
  log(`dispute #${disputeId} juror${jurorIndex} round ${round}: revealed ${verdict} -> ${r.hash}`);
  return { ok: true, kind, hash: r.hash, verdict };
}
revealVote.maxRetries = 2;

// ------------------------------------------------------------------ rationale + rewards

export async function publishRationale(disputeId: string, round: number, jurorIndex: number, rec: DecisionRecord, revealTx: Hex | null): Promise<ActionResult> {
  'use step';
  const kind = 'publish';
  const { cfg, clients, io, me } = ctx(jurorIndex);
  const id = BigInt(disputeId);
  const { d, seats } = await io.getDispute(id);
  const seat = panelSeat(d, seats, round, me);
  if (!seat?.revealed) return { ok: false, kind, reason: 'reveal not on-chain yet', retryable: true };
  const verdict: Verdict = seat.vote === 1 ? 'Uphold' : 'Reject';
  const doc = buildRationaleDoc({
    chainId: cfg.chainId,
    market: cfg.market,
    disputeId: id,
    round,
    juror: me,
    decision: rec.decision as Decision,
    verdict,
    commitment: seat.commitment,
    revealTx: revealTx ?? '0x',
  });
  const text = canonical(doc);
  try {
    const indexed = await postRationale(cfg.teeUrl, disputeId, text, (hash) => clients.account.signMessage({ message: { raw: hash } }));
    const stored = indexed ?? (await putBlob(cfg.teeUrl, new TextEncoder().encode(text)));
    log(`dispute #${disputeId} juror${jurorIndex} round ${round}: rationale published sha256 ${stored.sha256}`);
    return { ok: true, kind, sha256: stored.sha256, note: stored.url };
  } catch (e) {
    return { ok: false, kind, reason: `rationale upload failed: ${errMsg(e)}`, retryable: true };
  }
}
publishRationale.maxRetries = 1;

export async function withdrawRewards(jurorIndex: number): Promise<ActionResult> {
  'use step';
  const kind = 'withdraw';
  const { cfg, io } = ctx(jurorIndex);
  const off = disabled(kind, cfg);
  if (off) return off;
  const bal = await io.claimable();
  if (bal === 0n) return { ok: true, kind, note: 'nothing to withdraw' };
  const r = await io.send('withdraw', []);
  if (!r.ok) return { ok: false, kind, reason: r.reason, retryable: true };
  log(`juror${jurorIndex}: withdrew ${Number(bal) / 1e6} tUSDC -> ${r.hash}`);
  return { ok: true, kind, hash: r.hash, note: `${Number(bal) / 1e6} tUSDC` };
}
withdrawRewards.maxRetries = 2;

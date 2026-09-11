/**
 * EnvMarket AI juror agent (one process per juror).
 *
 *   JUROR_INDEX=1 tsx src/juror.ts run        # watch chain, act as keeper, judge, commit, reveal, tally, withdraw
 *   JUROR_INDEX=1 tsx src/juror.ts register   # approve token + deposit juror stake, publish disclosure metadata
 *   JUROR_INDEX=1 tsx src/juror.ts status     # print stake, claimable, model, prompt hash, tracked disputes
 *   JUROR_INDEX=1 tsx src/juror.ts withdraw   # withdraw pull-payment balance
 *
 * Restart safety: all progress lives in .data/juror{n}.json (atomic writes); the chain is the source
 * of truth for what was committed/revealed. The vote salt is persisted before commitVote is sent and
 * never regenerated, so a restart re-reveals from disk and can never commit twice.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  DisputeStatus,
  ensureAllowance,
  formatTusdc,
  Ground,
  indicesFromMask,
  loadEnv,
  makeClients,
  requireMarket,
  requireToken,
  type Clients,
  type EnvConfig,
} from '@envmarket/shared';
import { formatUnits, parseUnits, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { commitmentOf, prepareCommit, VERDICT_CODE } from './commit.ts';
import { decide } from './decide.ts';
import { EvidenceError, fetchCasePacket } from './evidence.ts';
import { resolveJurorLlm, sharesPanelFamily, type JurorLlm } from './llm.ts';
import { MarketIO, ZERO32, type DisputeView, type SeatView } from './market.ts';
import { buildRationaleDoc, publishRationale, putBlob } from './publish.ts';
import { loadRubric, sha256Hex, type Rubric } from './rubric.ts';
import { acquireLock, JurorStore, writeFileAtomic, type DisputeRecord } from './state.ts';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEATS = 3;

export interface JurorOptions {
  index: number;
  cfg: EnvConfig;
  clients: Clients;
  market: Address;
  dataDir: string;
  teeUrl?: string;
  pollMs: number;
  logRange: bigint;
  keeper: boolean;
  autoWithdraw: boolean;
  evidenceRetryMs: number;
}

function envFlag(v: string | undefined, dflt: boolean): boolean {
  return v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v);
}

export function loadJurorOptions(index: number): JurorOptions {
  if (!Number.isInteger(index) || index < 1 || index > 9) throw new Error('JUROR_INDEX must be 1..9');
  const cfg = loadEnv({ requireDeployment: true });
  const e = cfg.env;
  const pk = e[`JUROR${index}_PK`];
  if (!pk) throw new Error(`missing JUROR${index}_PK in environment/.env`);
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex);
  const clients = makeClients(account, { config: cfg });
  const local = cfg.chainId === 31337;
  return {
    index,
    cfg,
    clients,
    market: requireMarket(cfg),
    dataDir: path.resolve(e.JUROR_DATA_DIR ?? path.join(SERVICE_DIR, '.data')),
    teeUrl: (e.TEE_URL ?? (local ? 'http://localhost:8080' : undefined))?.replace(/\/+$/, ''),
    pollMs: Number(e.JUROR_POLL_MS ?? (local ? 1000 : 4000)),
    logRange: BigInt(e.JUROR_LOG_RANGE ?? 2000),
    keeper: envFlag(e.JUROR_KEEPER, true),
    autoWithdraw: envFlag(e.JUROR_AUTO_WITHDRAW, true),
    evidenceRetryMs: Number(e.JUROR_EVIDENCE_RETRY_MS ?? 5000),
  };
}

export class Juror {
  readonly o: JurorOptions;
  readonly io: MarketIO;
  readonly store: JurorStore;
  readonly rubric: Rubric;
  readonly me: Address;
  llm?: JurorLlm;
  private stopping = false;
  private pending = new Map<string, Promise<void>>();
  private lastEvidenceTry = new Map<string, number>();
  private lastNote = new Map<string, string>();

  constructor(o: JurorOptions) {
    this.o = o;
    this.io = new MarketIO(o.clients, o.market);
    this.me = o.clients.account.address;
    this.rubric = loadRubric();
    this.store = new JurorStore(path.join(o.dataDir, `juror${o.index}.json`), this.me, o.cfg.chainId, o.market, o.cfg.startBlock);
  }

  log(line: string): void {
    const t = new Date().toISOString().slice(11, 19);
    console.log(`[juror${this.o.index} ${t}] ${line}`);
  }

  /** Log a line only when it differs from the last one for this key (avoids per-tick spam). */
  note(key: string, line: string): void {
    if (this.lastNote.get(key) === line) return;
    this.lastNote.set(key, line);
    this.log(line);
  }

  async ensureLlm(): Promise<JurorLlm> {
    if (!this.llm) {
      this.llm = await resolveJurorLlm(this.o.index, this.o.cfg.env);
      const localNote = this.llm.kind === 'ollama-local' ? ' (LOCAL DEV: Ollama on this machine, not Fireworks)' : '';
      this.log(`model ${this.llm.model} via ${this.llm.kind} ${this.llm.baseUrl} [requested ${this.llm.requested}]${localNote}`);
    }
    return this.llm;
  }

  stop(): void {
    this.stopping = true;
  }

  // ------------------------------------------------------------------ main loop

  async run(): Promise<void> {
    const release = acquireLock(path.join(this.o.dataDir, `juror${this.o.index}.lock`));
    try {
      await this.ensureLlm();
      const info = await this.io.jurorInfo();
      this.log(
        `juror ${this.me} on chain ${this.o.cfg.chainId} market ${this.o.market}; approved=${info.approved} stake total=${formatTusdc(info.total)} locked=${formatTusdc(info.locked)}; prompt ${this.rubric.version} ${this.rubric.hash}; TEE ${this.o.teeUrl ?? '(none)'}; cursor ${this.store.cursor}`,
      );
      if (!info.approved) this.log('WARNING: not approved by the market owner; cannot be selected (run `register`).');
      while (!this.stopping) {
        const t0 = Date.now();
        try {
          await this.tick();
        } catch (e) {
          this.note('tick', `tick error: ${(e as Error).message}`);
        }
        const wait = Math.max(0, this.o.pollMs - (Date.now() - t0));
        await new Promise((r) => setTimeout(r, wait));
      }
      this.log('stopping: waiting for in-flight work');
      await Promise.allSettled(this.pending.values());
    } finally {
      release();
    }
  }

  async tick(): Promise<void> {
    const head = await this.io.head();
    await this.scanLogs(head.number);
    for (const rec of this.store.disputes()) {
      if (rec.resolved || this.stopping) continue;
      try {
        await this.drive(BigInt(rec.disputeId), rec, head);
      } catch (e) {
        this.note(`drive:${rec.disputeId}`, `dispute ${rec.disputeId}: ${(e as Error).message}`);
      }
    }
  }

  /** Discover FalseDescription disputes and panel draws from logs; advance the persisted cursor. */
  async scanLogs(headNumber: bigint): Promise<void> {
    let from = this.store.cursor + 1n;
    while (from <= headNumber && !this.stopping) {
      const to = from + this.o.logRange - 1n < headNumber ? from + this.o.logRange - 1n : headNumber;
      const logs = (await this.o.clients.publicClient.getContractEvents({
        address: this.o.market,
        abi: this.io.abi,
        fromBlock: from,
        toBlock: to,
      } as never)) as unknown as Array<{ eventName: string; args: Record<string, unknown>; blockNumber: bigint }>;
      for (const l of logs) {
        if (l.eventName === 'DisputeOpened' && Number(l.args.ground) === Ground.FalseDescription) {
          const id = l.args.disputeId as bigint;
          if (!this.store.dispute(id)) {
            this.store.ensureDispute(id, { purchaseId: String(l.args.purchaseId), discoveredAtBlock: String(l.blockNumber) });
            this.log(`DisputeOpened #${id} (FalseDescription, purchase ${l.args.purchaseId}, block ${l.blockNumber})`);
          }
        } else if (l.eventName === 'JurorsSelected') {
          const id = l.args.disputeId as bigint;
          const jurors = (l.args.jurors as Address[]).map((a) => a.toLowerCase());
          const seated = jurors.includes(this.me.toLowerCase());
          this.store.ensureDispute(id);
          this.log(`JurorsSelected #${id} round ${l.args.round}: ${seated ? 'SEATED' : 'not seated'} (commit by ${l.args.commitDeadline}, reveal by ${l.args.revealDeadline})`);
        }
      }
      this.store.setCursor(to);
      from = to + 1n;
    }
  }

  // ------------------------------------------------------------------ per-dispute state machine

  async drive(id: bigint, rec: DisputeRecord, head: { number: bigint; timestamp: bigint }): Promise<void> {
    const { d, seats } = await this.io.getDispute(id);
    if (d.ground !== Ground.FalseDescription) {
      this.store.update(() => (rec.resolved = true));
      return;
    }
    if (d.status === DisputeStatus.Resolved) return this.onResolved(id, rec, d, seats);

    if (d.status === DisputeStatus.AwaitingSelection) {
      if (this.o.keeper && head.number > d.selectionBlock) {
        const r = await this.io.send('selectJurors', [id]);
        if (r.ok) this.log(`keeper: selectJurors(#${id}) round ${d.round} -> ${r.hash}`);
        else this.note(`select:${id}`, `keeper: selectJurors(#${id}) not applied: ${r.reason}`);
      }
      return;
    }
    if (d.status !== DisputeStatus.Voting) return;

    const round = d.round;
    const base = (round - 1) * SEATS;
    const panel = seats.slice(base, base + SEATS);
    const seat = panel.find((s) => s.juror.toLowerCase() === this.me.toLowerCase());
    const now = head.timestamp;

    if (seat) {
      const allCommitted = panel.every((s) => s.commitment !== ZERO32);
      if (seat.commitment === ZERO32) {
        if (now <= d.commitDeadline) await this.commitPhase(id, round, d);
        else this.note(`late:${id}:${round}`, `dispute #${id} round ${round}: commit deadline passed without a commitment`);
      } else if (!seat.revealed) {
        if ((now > d.commitDeadline || allCommitted) && now <= d.revealDeadline) await this.revealPhase(id, round, seat);
        else if (now > d.revealDeadline) this.note(`late:${id}:${round}`, `dispute #${id} round ${round}: reveal deadline passed`);
      } else {
        await this.maybePublish(id, round);
      }
    }

    if (this.o.keeper) {
      const allRevealed = panel.every((s) => s.revealed);
      if (allRevealed || now > d.revealDeadline) {
        const r = await this.io.send('tallyDispute', [id]);
        if (r.ok) this.log(`keeper: tallyDispute(#${id}) round ${round} -> ${r.hash}`);
        else this.note(`tally:${id}`, `keeper: tallyDispute(#${id}) not applied: ${r.reason}`);
      }
    }
  }

  private chainFacts = async (id: bigint, round: number, d: DisputeView) => {
    const p = await this.io.read<{ versionId: bigint; taskCount: number; price: bigint }>('getPurchase', [d.purchaseId]);
    const v = await this.io.read<{ descriptionHash: Hex; taskCount: number }>('getVersion', [p.versionId]);
    const taskCount = Number(p.taskCount);
    return {
      chainId: this.o.cfg.chainId,
      market: this.o.market,
      disputeId: id.toString(),
      round,
      ground: 'FalseDescription (a specific claim in the frozen description is false)',
      purchaseId: d.purchaseId.toString(),
      versionId: p.versionId.toString(),
      frozenDescriptionHash: v.descriptionHash,
      taskCount,
      disputedTaskIndices: indicesFromMask(d.taskMask, taskCount),
      requestedRefund: formatUnits(d.requested, 6),
      buyerEvidenceHash: d.evidenceHash,
    };
  };

  /** Ensure a decision (async, off the tick), then persist the secret and send commitVote. */
  async commitPhase(id: bigint, round: number, d: DisputeView): Promise<void> {
    const key = `${id}:${round}`;
    const rr = this.store.round(id, round);
    if (!rr.verdict && !rr.decision) {
      if (this.pending.has(key)) return;
      const last = this.lastEvidenceTry.get(key) ?? 0;
      if (Date.now() - last < this.o.evidenceRetryMs) return;
      this.lastEvidenceTry.set(key, Date.now());
      const job = this.makeDecision(id, round, d).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
      return;
    }
    const verdict = rr.verdict ?? rr.decision!.output.verdict;
    const secret = prepareCommit(this.store, id, round, verdict, this.me); // durable before the tx
    const r = await this.io.send('commitVote', [id, secret.commitment], (hash) => this.store.update(() => (rr.commitTx = hash)));
    if (r.ok) {
      this.store.update(() => (rr.commitConfirmed = true));
      this.log(`committed #${id} round ${round} (${secret.commitment.slice(0, 10)}...) -> ${r.hash}`);
    } else {
      this.note(`commit:${key}`, `commitVote(#${id}) not applied: ${r.reason}`);
    }
  }

  private async makeDecision(id: bigint, round: number, d: DisputeView): Promise<void> {
    if (!this.o.teeUrl) {
      this.note(`ev:${id}:${round}`, `dispute #${id}: no TEE_URL configured; cannot fetch evidence (abstaining)`);
      return;
    }
    let packet;
    try {
      packet = await fetchCasePacket({ teeUrl: this.o.teeUrl, chainId: this.o.cfg.chainId, market: this.o.market, disputeId: id, account: this.o.clients.account });
    } catch (e) {
      const status = e instanceof EvidenceError ? e.status : null;
      this.note(`ev:${id}:${round}`, `dispute #${id}: evidence not available yet (${status ?? 'network'}): ${(e as Error).message.slice(0, 200)}`);
      return;
    }
    this.log(`dispute #${id} round ${round}: case packet ${packet.bytes} bytes sha256 ${packet.packetSha256}; deliberating`);
    const llm = await this.ensureLlm();
    const facts = await this.chainFacts(id, round, d);
    const t0 = Date.now();
    const decision = await decide({
      rubric: this.rubric,
      llm,
      chainFacts: facts,
      packet: packet.packet,
      packetText: packet.packetText,
      packetSha256: packet.packetSha256,
      log: (l) => this.log(`dispute #${id}: ${l}`),
    });
    const rr = this.store.round(id, round);
    if (rr.verdict || rr.decision) return; // never overwrite a persisted decision
    this.store.update(() => (rr.decision = decision));
    this.log(
      `dispute #${id} round ${round}: decided in ${((Date.now() - t0) / 1000).toFixed(1)}s by ${decision.model.served} (confidence ${decision.output.confidence}; screening ${decision.public.screening.passed ? 'passed' : `failed: ${decision.public.screening.reasons.join(', ')}`}) — verdict kept secret until reveal`,
    );
  }

  async revealPhase(id: bigint, round: number, seat: SeatView): Promise<void> {
    const rr = this.store.round(id, round);
    if (!rr.salt || !rr.verdict) {
      this.note(`reveal:${id}:${round}`, `dispute #${id} round ${round}: committed on-chain but no persisted secret; cannot reveal`);
      return;
    }
    const expect = commitmentOf({ disputeId: id, round, verdict: rr.verdict, salt: rr.salt, juror: this.me });
    if (expect !== seat.commitment) {
      this.note(`reveal:${id}:${round}`, `dispute #${id} round ${round}: persisted secret does not match on-chain commitment; refusing to reveal`);
      return;
    }
    const r = await this.io.send('revealVote', [id, VERDICT_CODE[rr.verdict], rr.salt], (hash) => this.store.update(() => (rr.revealTx = hash)));
    if (r.ok) {
      this.store.update(() => (rr.revealConfirmed = true));
      this.log(`revealed #${id} round ${round}: ${rr.verdict} -> ${r.hash}`);
      await this.maybePublish(id, round);
    } else {
      this.note(`reveal:${id}:${round}`, `revealVote(#${id}) not applied: ${r.reason}`);
    }
  }

  async maybePublish(id: bigint, round: number): Promise<void> {
    const rr = this.store.round(id, round);
    if (!rr.decision || !rr.verdict || !rr.commitment || rr.rationalePublished) return;
    const doc = buildRationaleDoc({
      chainId: this.o.cfg.chainId,
      market: this.o.market,
      disputeId: id,
      round,
      juror: this.me,
      decision: rr.decision,
      verdict: rr.verdict,
      commitment: rr.commitment,
      revealTx: (rr.revealTx ?? '0x') as Hex,
    });
    const pub = await publishRationale({ dataDir: this.o.dataDir, teeUrl: this.o.teeUrl, doc, log: (l) => this.log(l) });
    this.store.update(() => (rr.rationalePublished = { file: pub.file, sha256: pub.sha256, blobUrl: pub.blobUrl }));
  }

  async onResolved(id: bigint, rec: DisputeRecord, d: DisputeView, seats: SeatView[]): Promise<void> {
    const verdict = d.fallbackNoQuorum ? 'FallbackNoQuorum' : d.verdict === 1 ? 'Uphold' : 'Reject';
    const mine = seats
      .map((s, i) => ({ s, round: Math.floor(i / SEATS) + 1 }))
      .filter(({ s }) => s.juror.toLowerCase() === this.me.toLowerCase());
    for (const { round } of mine) await this.maybePublish(id, round).catch(() => undefined);
    const outcome = mine.length
      ? mine.map(({ s, round }) => `round ${round}: voted ${s.revealed ? (s.vote === 1 ? 'Uphold' : 'Reject') : 'none'}, reward ${formatTusdc(s.reward)}, slashed ${formatTusdc(s.slashed)}`).join('; ')
      : 'not seated';
    this.log(`dispute #${id} resolved: ${verdict}, refund ${formatTusdc(d.refund)}; me: ${outcome}`);
    this.store.update(() => {
      rec.resolved = true;
      rec.finalVerdict = verdict;
    });
    if (this.o.autoWithdraw && mine.length) {
      const hash = await this.withdraw();
      if (hash) this.store.update(() => (rec.withdrawTx = hash));
    }
  }

  async withdraw(): Promise<Hash | null> {
    const bal = await this.io.claimable();
    if (bal === 0n) return null;
    const r = await this.io.send('withdraw', []);
    if (r.ok) {
      this.log(`withdrew ${formatTusdc(bal)} -> ${r.hash}`);
      return r.hash;
    }
    this.note('withdraw', `withdraw not applied: ${r.reason}`);
    return null;
  }

  // ------------------------------------------------------------------ registration

  async register(opts: { selfApproveLocal: boolean }): Promise<void> {
    const cfg = this.o.cfg;
    let info = await this.io.jurorInfo();
    if (!info.approved) {
      if (opts.selfApproveLocal && cfg.chainId === 31337 && cfg.keys.deployer) {
        const owner = makeClients(cfg.keys.deployer, { config: cfg });
        const r = await new MarketIO(owner, this.o.market).send('approveJuror', [this.me, true]);
        if (!r.ok) throw new Error(`approveJuror failed: ${r.reason}`);
        this.log(`LOCAL ANVIL ONLY: owner approved juror ${this.me} -> ${r.hash}`);
        info = await this.io.jurorInfo();
      } else {
        throw new Error(`juror ${this.me} is not approved; the market owner must call approveJuror(${this.me}, true) (demo admission is allowlisted)`);
      }
    }
    const params = await this.io.read<{ jurorStake: bigint }>('params');
    const e = cfg.env;
    const target = e.JUROR_STAKE ? parseUnits(e.JUROR_STAKE, 6) : params.jurorStake * BigInt(e.JUROR_STAKE_SEATS ?? 2);
    const need = target > info.total ? target - info.total : 0n;
    if (need > 0n) {
      const token = requireToken(cfg);
      const bal = await this.o.clients.publicClient.readContract({
        address: token,
        abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [this.me],
      });
      if (bal < need) throw new Error(`token balance ${formatTusdc(bal)} < stake needed ${formatTusdc(need)} at ${token}`);
      const approveHash = await ensureAllowance(this.o.clients, this.o.market, need, { tokenAddress: token });
      if (approveHash) this.log(`approved ${formatTusdc(need)} to market -> ${approveHash}`);
      const r = await this.io.send('depositJurorStake', [need]);
      if (!r.ok) throw new Error(`depositJurorStake failed: ${r.reason}`);
      this.log(`deposited juror stake ${formatTusdc(need)} -> ${r.hash}`);
    } else {
      this.log(`stake already ${formatTusdc(info.total)} >= target ${formatTusdc(target)}`);
    }
    await this.publishDisclosure();
    const after = await this.io.jurorInfo();
    this.log(`registered: approved=${after.approved} stake total=${formatTusdc(after.total)} free=${formatTusdc(after.free)}`);
  }

  async publishDisclosure(): Promise<{ sha256: Hex; file: string; url?: string }> {
    const e = this.o.cfg.env;
    const n = this.o.index;
    const llm = await this.ensureLlm();
    const meta = {
      type: 'envmarket.juror.v1',
      chainId: this.o.cfg.chainId,
      market: this.o.market.toLowerCase(),
      juror: this.me.toLowerCase(),
      operator: e[`JUROR${n}_OPERATOR`] ?? e.JUROR_OPERATOR ?? 'EnvMarket demo operator (controlled juror identity)',
      model: { provider: llm.kind, baseUrl: llm.baseUrl, requested: llm.requested, resolved: llm.model },
      sharesBaseFamilyWithReferencePanel: sharesPanelFamily(llm.model),
      promptVersion: this.rubric.version,
      promptHash: this.rubric.hash,
      expertise: e[`JUROR${n}_EXPERTISE`] ?? 'software environments; reading RL environment descriptions against mechanical evidence',
      conflicts: (e[`JUROR${n}_CONFLICTS`] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      disclosure: 'Controlled demo juror process: shares an operator with the other demo jurors; not independent.',
      createdAt: new Date().toISOString(),
    };
    const text = canonicalJson(meta);
    const bytes = new TextEncoder().encode(text);
    const sha256 = sha256Hex(bytes);
    const file = path.join(this.o.dataDir, `juror${n}-disclosure.json`);
    writeFileAtomic(file, text);
    let url: string | undefined;
    if (this.o.teeUrl) {
      try {
        url = (await putBlob(this.o.teeUrl, bytes)).url;
      } catch (err) {
        this.log(`disclosure blob upload failed (kept locally): ${(err as Error).message}`);
      }
    }
    this.log(`disclosure sha256 ${sha256}${url ? ` -> ${url}` : ''} (${file})`);
    return { sha256, file, url };
  }

  async status(): Promise<void> {
    const info = await this.io.jurorInfo();
    const bal = await this.io.claimable();
    const llm = await this.ensureLlm();
    console.log(
      JSON.stringify(
        {
          juror: this.me,
          index: this.o.index,
          chainId: this.o.cfg.chainId,
          market: this.o.market,
          approved: info.approved,
          stake: { total: formatTusdc(info.total), locked: formatTusdc(info.locked), free: formatTusdc(info.free) },
          claimable: formatTusdc(bal),
          model: { provider: llm.kind, baseUrl: llm.baseUrl, requested: llm.requested, resolved: llm.model },
          prompt: { version: this.rubric.version, sha256: this.rubric.hash },
          cursor: this.store.cursor.toString(),
          disputes: this.store.disputes(),
        },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith('--')) ?? 'run';
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? '') : undefined;
  };
  const index = Number(flag('juror') ?? process.env.JUROR_INDEX);
  const juror = new Juror(loadJurorOptions(index));
  if (cmd === 'run') {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => juror.stop());
    await juror.run();
  } else if (cmd === 'register') {
    await juror.register({ selfApproveLocal: args.includes('--self-approve-local') });
  } else if (cmd === 'status') {
    await juror.status();
  } else if (cmd === 'withdraw') {
    const h = await juror.withdraw();
    if (!h) juror.log('nothing to withdraw');
  } else if (cmd === 'disclose') {
    await juror.publishDisclosure();
  } else {
    throw new Error(`unknown command ${cmd} (run | register | status | withdraw | disclose)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[juror${process.env.JUROR_INDEX ?? '?'}] fatal: ${(e as Error).stack ?? e}`);
    process.exit(1);
  });
}

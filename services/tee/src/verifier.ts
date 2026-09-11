/**
 * Mechanical verifier for BrokenOrHashMismatch and PreviewNotReproducible disputes.
 *
 * BrokenOrHashMismatch: recheck the stored ciphertext against the version's ciphertextHash, the
 *   decrypted archive against bundleHash, and the delivered wrapped key (re-derived byte-for-byte
 *   from the stored ephemeral key; its hash must equal the on-chain wrappedKeyHash). Any mismatch
 *   confirms every masked task. Otherwise rebuild (install requirements.lock) and, for each masked
 *   task, run the hidden tests against the delivered reference solution, twice, in the offline
 *   sandbox. A task is "broken" if, in both runs, the grader cannot be imported (build failure),
 *   the task crashes, no hidden test is collected, or the hidden tests fail on the reference solution.
 *
 * PreviewNotReproducible (both halves run in the reference harness, harness/envmarket_coding):
 *   (1) `--regrade`: every original episode's stored final workspace on the masked tasks is graded
 *       again with the hidden tests — score and graded tree digest must match exactly (tolerance 0);
 *   (2) each model re-runs the masked tasks once under the report's protocol; per-model pass rates
 *       on the masked set are compared with the precommitted tolerance (5 pp). Tasks whose outcome
 *       changed (or whose re-grade did not match) are confirmed.
 *
 * Findings: public findings JSON (aggregates only, no audit data) → findingsHash (sha256 of its
 * canonical JSON) stored as a blob; the full private findings (logs, per-episode detail) stay in
 * the private store. Signs MechanicalFinding and submits resolveMechanical.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, fromBase64, indicesFromMask, sha256Hex, signMechanicalFinding } from '@envmarket/shared';
import type { Hex } from 'viem';
import { loadUpload, openAudit, openBundle, runTaskChecks, type Check, type TaskCheckRow } from './bundle.ts';
import { domainOf, requireChain, type Ctx } from './context.ts';
import { missingEpisode, regradeHarness, runHarness, toEpisodeResult, type EpisodeResult } from './harnessRunner.ts';
import { errMsg, logger } from './log.ts';
import { getRunRecord, PROTOCOL_ID } from './preview.ts';
import { getDeliveryRecord, rederiveWrappedKey } from './relay.ts';
import { prepareVenv } from './sandbox.ts';

export const GROUND = { BrokenOrHashMismatch: 1, FalseDescription: 2, PreviewNotReproducible: 3 } as const;
const DS_VOTING = 2;

export interface FindingRecord {
  disputeId: string;
  findings: Record<string, unknown>;
  findingsHash: Hex;
  upheld: boolean;
  confirmedMask: string;
  signature: Hex;
  tx: Hex | null;
  error: string | null;
  private: Record<string, unknown>;
}

function brokenReasons(row: TaskCheckRow | undefined, importsOk: boolean): string[] {
  const r: string[] = [];
  if (!importsOk) r.push('build failure: grader cannot be imported');
  if (!row) return [...r, 'task not checked'];
  if (!row.ok) r.push(`crash: ${row.error ?? 'task check failed'}`);
  if ((row.hiddenTestCount ?? 0) === 0) r.push('no hidden tests collected');
  if (row.solution?.present && !row.solution.allPassed) r.push(`hidden tests fail on the reference solution (${row.solution.failed ?? '?'} failed${row.solution.timedOut ? ', timed out' : ''})`);
  return r;
}

async function verifyBroken(ctx: Ctx, disputeId: bigint, d: { taskMask: bigint; purchaseId: bigint }) {
  const chain = requireChain(ctx);
  const p = (await chain.getPurchase(d.purchaseId))!;
  const v = (await chain.getVersion(p.versionId))!;
  const up = loadUpload(ctx, v.ciphertextHash);
  if (!up) throw new Error('no upload record for the disputed version (cannot verify)');
  const idx = indicesFromMask(d.taskMask, v.taskCount);
  const masked = idx.map((i) => ({ index: i, taskId: up.taskIds[i]! }));
  const checks: Check[] = [];
  let hashMismatch = false;
  let payloadDir: string | null = null;
  try {
    const opened = openBundle(ctx, { ciphertextHash: v.ciphertextHash, bundleHash: v.bundleHash, bundleKey: up.bundleKey }, `d${disputeId}`);
    payloadDir = opened.dir;
    checks.push(...opened.checks);
  } catch (e) {
    checks.push({ name: 'bundle.open', ok: false, detail: errMsg(e) });
  }
  checks.push({ name: 'version.ciphertextHash == purchase.ciphertextHash', ok: p.ciphertextHash.toLowerCase() === v.ciphertextHash.toLowerCase() });
  const rec = getDeliveryRecord(ctx, d.purchaseId);
  if (rec) {
    const stored = fromBase64(rec.wrappedKey);
    checks.push({ name: 'delivery.wrappedKeyHash == on-chain', ok: sha256Hex(stored) === p.wrappedKeyHash.toLowerCase() });
    checks.push({ name: 'delivery.wrapperHash == on-chain', ok: rec.wrapperHash === p.wrapperHash.toLowerCase() });
    checks.push({ name: 'delivery.wrappedKey re-derives (K_bundle to buyerEncPubKey)', ok: Buffer.from(await rederiveWrappedKey(rec, up.bundleKey)).equals(Buffer.from(stored)) });
    checks.push({ name: 'delivery.wrapper.bundleHash', ok: JSON.parse(rec.wrapperJson).bundleHash === v.bundleHash.toLowerCase() });
  } else {
    checks.push({ name: 'delivery.record', ok: false, detail: 'delivery was not produced by this relay; key validity cannot be re-derived' });
  }
  hashMismatch = checks.some((c) => !c.ok && c.name !== 'delivery.record');

  const runs: Array<{ importsOk: boolean; rows: TaskCheckRow[]; error: string | null }> = [];
  let depOk = true;
  if (payloadDir && !hashMismatch) {
    const dep = await prepareVenv(ctx.sandbox, ctx.cacheRoot, fs.readFileSync(path.join(payloadDir, 'requirements.lock'), 'utf8'));
    depOk = dep.ok;
    if (dep.ok) {
      const sol = fs.existsSync(path.join(payloadDir, 'solutions')) ? path.join(payloadDir, 'solutions') : null;
      for (let k = 0; k < 2; k++) {
        const r = await runTaskChecks(ctx, dep.venv, payloadDir, [path.join(payloadDir, 'tasks')], masked.map((m) => m.taskId), sol);
        runs.push({ importsOk: !!r.output?.imports.ok, rows: r.output?.tasks ?? [], error: r.error });
      }
    }
  }
  if (payloadDir) fs.rmSync(payloadDir, { recursive: true, force: true });

  const tasks = masked.map((m) => {
    if (hashMismatch) return { ...m, verdict: 'confirmed', reasons: ['payload or key does not match the on-chain commitment'] };
    if (!depOk) return { ...m, verdict: 'confirmed', reasons: ['build failure: pinned dependencies do not install'] };
    const per = runs.map((r) => brokenReasons(r.rows.find((x) => x.taskId === m.taskId), r.importsOk && !r.error));
    const both = per.length === 2 && per.every((x) => x.length > 0);
    const row = runs[0]?.rows.find((x) => x.taskId === m.taskId);
    return {
      ...m,
      verdict: both ? 'confirmed' : per.some((x) => x.length > 0) ? 'not-reproducible' : 'not-broken',
      reasons: [...new Set(per.flat())],
      hiddenTests: row ? { collected: row.hiddenTestCount ?? 0, referenceSolution: row.solution?.present ? { passed: row.solution.passed, failed: row.solution.failed } : 'absent' } : null,
    };
  });
  const confirmed = tasks.filter((t) => t.verdict === 'confirmed').map((t) => t.index);
  return {
    publicPart: { checks: checks.map((c) => ({ name: c.name, ok: c.ok })), hashOrKeyMismatch: hashMismatch, dependenciesInstall: depOk, runs: runs.length, tasks },
    privatePart: { checks, runs },
    confirmed,
  };
}

async function verifyRepro(ctx: Ctx, disputeId: bigint, d: { taskMask: bigint; purchaseId: bigint }) {
  const chain = requireChain(ctx);
  const h = ctx.harness;
  if (!h) throw new Error('reference harness unavailable');
  const p = (await chain.getPurchase(d.purchaseId))!;
  const v = (await chain.getVersion(p.versionId))!;
  const up = loadUpload(ctx, v.ciphertextHash);
  if (!up) throw new Error('no upload record for the disputed version');
  const run = getRunRecord<{ episodes: EpisodeResult[]; models: { panel: Array<{ requested: string; resolved: string | null; status: string; provider: string | null }> } }>(ctx, p.versionId);
  if (!run) throw new Error('no private run record for this version (report not produced by this runner)');
  const idx = indicesFromMask(d.taskMask, v.taskCount);
  const masked = idx.map((i) => ({ index: i, taskId: up.taskIds[i]! }));
  const { dir: payloadDir } = openBundle(ctx, up, `r${disputeId}`);
  const auditDir = openAudit(ctx, up, `r${disputeId}`);
  try {
    const dep = await prepareVenv(ctx.sandbox, ctx.cacheRoot, up.requirementsLock);
    if (!dep.ok) throw new Error('dependency install failed');
    // (1) deterministic re-grade of stored final workspaces (tolerance 0)
    const originals = run.episodes.filter((e) => e.set === 'purchased' && masked.some((m) => m.taskId === e.taskId));
    const gradable = originals.filter((e) => e.status !== 'infra_failure' && e.grade);
    const regrade = gradable.length ? await regradeHarness(ctx, h, { payloadDir, auditDir, episodes: gradable, venv: dep.venv, label: `d${disputeId}` }) : { rows: [], mismatches: 0, exitCode: 0, stderrTail: '' };
    const rowFor = (e: EpisodeResult) => regrade.rows.find((r) => r.episodeId === (e.harnessEpisodeId ?? e.jobId));
    const regrades = gradable.map((e) => {
      const r = rowFor(e);
      return { jobId: e.jobId, taskId: e.taskId, requested: e.requested, match: !!r?.match, score: r?.score ?? null, originalScore: e.grade!.score, error: r ? r.error : 'not re-graded by the harness' };
    });

    // (2) one LLM re-run per (model, masked task) under the same protocol, in the harness
    const runnable = run.models.panel.map((m, mi) => ({ m, mi })).filter((x) => x.m.status === 'run' && x.m.resolved);
    const rerun = runnable.length
      ? await runHarness(ctx, h, { payloadDir, auditDir, split: 'purchased', tasks: masked.map((m) => m.taskId), models: runnable.map((x) => x.m.resolved!), concurrency: ctx.cfg.preview.concurrency, venv: dep.venv, label: `d${disputeId}-repro` })
      : null;
    const reruns: EpisodeResult[] = [];
    for (const x of runnable) {
      for (const t of masked) {
        const meta = { jobId: `d${disputeId}.repro.m${x.mi}.t${t.index}`, requested: x.m.requested, provider: x.m.provider ?? ctx.cfg.llm.provider, set: 'purchased' as const };
        const rec = rerun?.records.find((r) => r.requestedModel === x.m.resolved && r.taskId === t.taskId);
        reruns.push(rec ? toEpisodeResult(rec, meta) : missingEpisode(meta, x.m.resolved!, t.taskId, `harness reported no record (exit ${rerun?.exitCode})`));
      }
    }
    if (rerun && Object.keys(rerun.transcripts).length) ctx.priv.put('transcripts', `d${disputeId}-repro`, rerun.transcripts);

    const confirmed = new Set<number>();
    for (const r of regrades) if (!r.match) confirmed.add(masked.find((m) => m.taskId === r.taskId)!.index);
    const perModel = runnable.map(({ m }) => {
      const orig = originals.filter((e) => e.requested === m.requested);
      const re = reruns.filter((e) => e.requested === m.requested);
      const n = masked.length;
      const o = orig.filter((e) => e.solved).length;
      const rr = re.filter((e) => e.solved).length;
      const deltaPp = n ? (Math.abs(rr - o) * 100) / n : 0;
      const exceeded = deltaPp > 5;
      if (exceeded) {
        for (const t of masked) {
          const a = orig.find((e) => e.taskId === t.taskId)?.solved ?? false;
          const b = re.find((e) => e.taskId === t.taskId)?.solved ?? false;
          if (a !== b) confirmed.add(t.index);
        }
      }
      return { requested: m.requested, resolved: m.resolved, maskedTasks: n, originalSolved: o, rerunSolved: rr, deltaPp, tolerancePp: 5, exceeded, rerunInfraFailures: re.filter((e) => e.status === 'infra_failure').length };
    });
    return {
      publicPart: {
        protocol: PROTOCOL_ID,
        harness: h.digest.harnessId,
        deterministicRegrade: { tolerance: 0, episodes: regrades.length, mismatches: regrades.filter((r) => !r.match).length },
        llmRerun: perModel,
      },
      privatePart: { regrades, regradeStderr: regrade.stderrTail, reruns, rerunExit: rerun?.exitCode ?? null },
      confirmed: [...confirmed].sort((a, b) => a - b),
    };
  } finally {
    fs.rmSync(payloadDir, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
}

const inflight = new Map<string, Promise<FindingRecord | null>>();

export function handleDisputeOpened(ctx: Ctx, disputeId: bigint): Promise<FindingRecord | null> {
  const k = disputeId.toString();
  const running = inflight.get(k);
  if (running) return running;
  const p = verifyDispute(ctx, disputeId).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function verifyDispute(ctx: Ctx, disputeId: bigint): Promise<FindingRecord | null> {
  const chain = requireChain(ctx);
  const got = await chain.getDispute(disputeId);
  if (!got) return null;
  const d = got.dispute;
  if (d.ground !== GROUND.BrokenOrHashMismatch && d.ground !== GROUND.PreviewNotReproducible) return null;
  let rec = ctx.priv.get<FindingRecord>('findings', `d${disputeId}`);
  if (d.status !== DS_VOTING) return rec; // already resolved (or timed out)
  if (Number(d.verifierDeadline) < Date.now() / 1000) {
    logger.warn('verifier deadline passed; anyone may call timeoutMechanical', { disputeId });
    return rec;
  }
  if (!rec) {
    logger.info('verifying dispute', { disputeId, ground: d.ground, taskMask: d.taskMask });
    const res = d.ground === GROUND.BrokenOrHashMismatch ? await verifyBroken(ctx, disputeId, d) : await verifyRepro(ctx, disputeId, d);
    const confirmedMask = res.confirmed.reduce((m, i) => m | (1n << BigInt(i)), 0n) & d.taskMask;
    const upheld = confirmedMask !== 0n;
    const p = (await chain.getPurchase(d.purchaseId))!;
    const findings = {
      type: 'envmarket.findings.v1',
      disputeId: disputeId.toString(),
      purchaseId: d.purchaseId.toString(),
      versionId: p.versionId.toString(),
      ground: d.ground === GROUND.BrokenOrHashMismatch ? 'BrokenOrHashMismatch' : 'PreviewNotReproducible',
      taskMask: d.taskMask.toString(),
      result: res.publicPart,
      upheld,
      confirmedMask: confirmedMask.toString(),
      rule:
        d.ground === GROUND.BrokenOrHashMismatch
          ? 'confirmed iff payload/key mismatch, dependency build failure, or (in two independent sandboxed runs) grader import failure / task crash / no hidden tests collected / hidden tests failing on the delivered reference solution'
          : 'confirmed iff a stored final workspace re-grades differently (harness --regrade, tolerance 0) or a model\'s harness re-run pass rate on the masked tasks differs by more than 5 percentage points (outcome-changed tasks confirmed)',
      sandbox: ctx.sandbox.description,
      verifier: ctx.keys.account.address,
      attestation: ctx.attestor.reportBlock(),
      createdAt: new Date().toISOString(),
    };
    const json = canonicalJson(findings);
    const findingsHash = sha256Hex(json);
    ctx.blobs.put(json);
    const signature = await signMechanicalFinding(ctx.keys.account, domainOf(ctx), { disputeId, upheld, confirmedMask, findingsHash });
    rec = { disputeId: disputeId.toString(), findings, findingsHash, upheld, confirmedMask: confirmedMask.toString(), signature, tx: null, error: null, private: res.privatePart as Record<string, unknown> };
    ctx.priv.put('findings', `d${disputeId}`, rec);
  }
  if (!ctx.cfg.submitTxs || rec.tx) return rec;
  try {
    const { hash } = await chain.write('resolveMechanical', [disputeId, rec.upheld, BigInt(rec.confirmedMask), rec.findingsHash, rec.signature], `resolveMechanical(d${disputeId})`);
    rec.tx = hash;
    rec.error = null;
  } catch (e) {
    rec.error = errMsg(e).slice(0, 500);
    ctx.priv.put('findings', `d${disputeId}`, rec);
    throw e;
  }
  ctx.priv.put('findings', `d${disputeId}`, rec);
  logger.info('dispute resolved', { disputeId, upheld: rec.upheld, confirmedMask: rec.confirmedMask, tx: rec.tx });
  return rec;
}

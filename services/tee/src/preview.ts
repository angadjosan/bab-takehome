/**
 * Preview runner: POST /preview/:versionId, quotes: GET /preview/quote/:versionId.
 *
 * Payment (EnvMarket seller-paid previews): the seller fetches a signed quote (quoteHash = sha256 of
 * its canonical JSON), then calls requestPreview(versionId, fee, quoteHash). Before any inference the
 * TEE checks previewInfo(versionId): paid, not released, not reclaimed, quoteHash is a quote THIS
 * service issued for this version, fee >= quote.feeUsdc, paid while the quote was valid, and the run
 * can finish before previewDeadline(versionId). attachReport (which releases the fee) is submitted
 * immediately after signing.
 *
 * Episodes run in the open-source reference harness `harness/envmarket_coding` (Prime Intellect
 * verifiers 0.3.1) as a subprocess (see harnessRunner.ts); every panel model × every purchased and
 * audit task, one episode each (pass@1). Inference runs ONCE per environment: the run is cached by
 * (bundleHash, auditRoot, protocol commitment, model ids) — see cache.ts — and a later version /
 * listing / contract / chain with the same content gets a freshly signed report rebuilt from the
 * cached run (original jobs/dates, `cachedFrom`).
 */
import * as fs from 'node:fs';
import {
  canonicalJson,
  pass1Rounded,
  REPORT_TYPE,
  reportHash as computeReportHash,
  reportSchema,
  serializeReport,
  sha256Hex,
  signPreviewReport,
  SUCCESS_RULE_ALL_TESTS,
  type Report,
} from '@envmarket/shared';
import type { Hex } from 'viem';
import { loadUpload, openAudit, openBundle, type UploadRecord } from './bundle.ts';
import { getCacheEntry, previewCacheKey, putCacheEntry, signEntry, type PreviewCacheEntry, type PreviewCacheKeyInput } from './cache.ts';
import { abiHas, ZERO32, type VersionTerms } from './chain.ts';
import { domainOf, requireChain, type Ctx } from './context.ts';
import { COST_MODEL_VERSION, feeUsdcBaseUnits, quotePreviewCost, tokenBudgetFor, type CostQuote } from './cost.ts';
import { bundleDigest, missingEpisode, runHarness, toEpisodeResult, type EpisodeResult } from './harnessRunner.ts';
import { errMsg, logger } from './log.ts';
import { llmClient, resolveModels, type ResolvedModels } from './models.ts';
import { prepareVenv } from './sandbox.ts';
import { nowIso } from './util.ts';
import { buildScreeningIndex, buildValidatorInput, collectFiles, runValidator, SCREENING_RULES, validatorPromptHash, VALIDATOR_PROMPT_VERSION, type ValidatorResult } from './validator.ts';

/** v2: episodes run in the verifiers-based reference harness (v1 was the former TypeScript loop). */
export const PROTOCOL_ID = 'envmarket.preview.v2';
export const LEGACY_PROTOCOL_IDS = ['envmarket.preview.v1'];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function requireHarness(ctx: Ctx) {
  if (!ctx.harness) throw new HttpError(503, 'reference harness unavailable (harness/envmarket_coding; HARNESS_DIR / HARNESS_PYTHON)');
  return ctx.harness;
}

/** The public, precommitted protocol. Its sha256 (with the bundle's toolsDigest) is report.protocol.harnessDigest. */
export function protocolSpec(ctx: Ctx): Record<string, unknown> {
  const h = requireHarness(ctx);
  const p = ctx.cfg.preview;
  return {
    id: PROTOCOL_ID,
    harness: {
      id: h.digest.harnessId,
      source: 'harness/envmarket_coding (Prime Intellect verifiers, MIT)',
      harnessDigest: h.digest.harnessDigest,
      promptDigest: h.digest.promptDigest,
      verifiersVersion: h.digest.verifiersVersion,
      protocol: h.digest.protocol,
    },
    decoding: { temperature: p.temperature, seed: p.seed, maxTokens: p.maxTokens },
    actionBudget: p.actionBudget,
    timeBudgetSec: p.episodeTimeSec,
    tokenBound:
      'per episode and model, docs/PREVIEW_COST.md fullBudgetIn/fullBudgetOut passed to the harness as --max-episode-tokens MODEL=IN:OUT: a model call is not started if cumulative prompt tokens plus the next prompt could exceed fullBudgetIn, and max_tokens is capped at the remaining fullBudgetOut; such an episode ends with termination token_budget and counts as failed. quote.worstCaseUsd is therefore a bound (up to the 3 chars/token estimate of the next prompt)',
    costModel: COST_MODEL_VERSION,
    taskSelection: 'every purchased task and every audit task, exactly one episode per model (pass@1); no retries, no best-of',
    successRule: SUCCESS_RULE_ALL_TESTS + ' (and the episode ended by submit)',
    failures: 'budget exhaustion, timeout, no submit and infrastructure failures all count as attempted and not solved; infrastructure failures (including episodes the harness did not report) are also reported per model',
    rounding: 'pass@1 rounded to the nearest 5 percentage points (half up), purchased and audit reported separately',
    panel: { requested: ['GLM 5.3', 'Kimi K3', 'Qwen 3.8'], resolution: 'pinned provider model ids checked against the live model list; unavailable models are reported as unavailable, never substituted by another family' },
    reuse: 'a run is reused for any version with the same bundleHash, auditRoot, protocol commitment and model ids (report.cachedFrom); runs with infrastructure failures are not reused',
    reproducibility: {
      repeatCount: 1,
      deterministicRegradeTolerance: 0,
      deterministicRegrade: 'harness --regrade: each original episode\'s stored final workspace is graded again with the hidden tests; score and graded tree digest must match exactly',
      llmRerunTolerancePp: 5,
      llmRerun: 'each masked task is re-run once per model through the harness under this protocol; per model, |rerun pass rate - original pass rate| over the masked tasks must be <= 5 percentage points (at this population size a single changed outcome exceeds it)',
    },
    validator: { promptVersion: VALIDATOR_PROMPT_VERSION, promptHash: validatorPromptHash(), screening: SCREENING_RULES },
    sandbox: 'harness agent phase and grade phase run in separate offline sandboxes (docker, or unshare/setpriv/prlimit + seccomp net-deny in the TEE); the agent phase never contains hidden tests or solutions',
  };
}

/** Commitment for report.protocol.harnessDigest; the preimage is published as a blob. */
export function protocolCommitment(ctx: Ctx, toolsDigest: string | null): { json: string; digest: Hex } {
  const json = canonicalJson({ type: 'envmarket.protocol-commitment.v1', spec: protocolSpec(ctx), toolsDigest });
  return { json, digest: sha256Hex(json) };
}

export interface StoredReport {
  versionId: string;
  protocolId: string;
  report: Report;
  reportJson: string;
  reportHash: Hex;
  signature: Hex;
  signer: string;
  attestationToken: string | null;
  attachTx: Hex | null;
  attachError: string | null;
  cacheKey: Hex | null;
  reusedCache: boolean;
  /** actual inference spend for THIS report (0 when a cached run was reused) */
  inferenceCostUsd: number;
  /** fee the seller escrowed on-chain (USDC base units) */
  feePaidUsdc: string | null;
  quoteHash: Hex | null;
  createdAt: string;
}

const reportKey = (versionId: bigint, protocolId = PROTOCOL_ID) => `v${versionId}-${protocolId}`;

export function getStoredReport(ctx: Ctx, versionId: bigint): StoredReport | null {
  for (const id of [PROTOCOL_ID, ...LEGACY_PROTOCOL_IDS]) {
    const r = ctx.priv.get<StoredReport>('reports', reportKey(versionId, id));
    if (r) return r;
  }
  return null;
}

/** Private run record for a version (current or legacy protocol). */
export function getRunRecord<T>(ctx: Ctx, versionId: bigint): T | null {
  for (const id of [PROTOCOL_ID, ...LEGACY_PROTOCOL_IDS]) {
    const r = ctx.priv.get<T>('runs', reportKey(versionId, id));
    if (r) return r;
  }
  return null;
}

export function termsMismatches(terms: VersionTerms, up: UploadRecord): string[] {
  const out: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => {
    if (String(a).toLowerCase() !== String(b).toLowerCase()) out.push(`${name}: on-chain ${String(a)} != uploaded ${String(b)}`);
  };
  eq('bundleHash', terms.bundleHash, up.bundleHash);
  eq('ciphertextHash', terms.ciphertextHash, up.ciphertextHash);
  eq('taskRoot', terms.taskRoot, up.taskRoot);
  eq('auditRoot', terms.auditRoot, up.auditRoot);
  eq('taskCount', terms.taskCount, up.taskIds.length);
  eq('auditTaskCount', terms.auditTaskCount, up.auditTaskIds.length);
  eq('manifestHash', terms.manifestHash, up.manifestHash);
  eq('descriptionHash', terms.descriptionHash, up.descriptionHash);
  eq('imageDigest', terms.imageDigest, up.imageDigest);
  if (up.licenseHash) eq('licenseHash', terms.licenseHash, up.licenseHash);
  return out;
}

export function disclosures(ctx: Ctx, provider: string): string[] {
  return [
    ctx.attestor.state.kind === 'none-local-dev'
      ? 'LOCAL DEVELOPMENT RUN: not inside a TEE; the host operator can read plaintext. attestation.kind = none-local-dev.'
      : ctx.attestor.state.kind === 'phala-dstack-tdx'
        ? `Runner, relay and verifier execute inside a Phala Cloud dstack CVM (Intel TDX); the signer is the dstack KMS app key for app ${ctx.attestor.state.appId}, bound to the attested compose by the quote's report_data. The app developer can push a new compose/image and the Phala KMS operator is trusted.`
        : 'Runner, relay and verifier execute inside an EigenCompute TEE (Intel TDX); the signer is bound to the attested app by the runtime attestation token.',
    provider === 'ollama'
      ? 'Inference ran on a local Ollama endpoint (harness check only); the GLM 5.3 / Kimi K3 / Qwen 3.8 panel was NOT run and is reported as unavailable.'
      : `The inference provider (${provider}) receives task statements and workspace file contents during preview episodes and receives the environment files when the validator runs; the TEE protects keys, hidden tests, grading and signing, not model inference.`,
    'A signature identifies the report signer; it does not prove the findings are true. pass@1 on reference models does not establish training value.',
  ];
}

// ------------------------------------------------------------------------------ models + cache key
let modelMemo: { at: number; value: ResolvedModels } | null = null;
/** Model resolution (live model list + validator probe), memoized for 10 minutes. */
export async function resolveModelsCached(ctx: Ctx): Promise<ResolvedModels> {
  if (modelMemo && Date.now() - modelMemo.at < 600_000) return modelMemo.value;
  const value = await resolveModels(ctx.cfg.llm);
  if (value.panel.some((m) => m.status === 'run')) modelMemo = { at: Date.now(), value };
  return value;
}

export function cacheKeyInput(ctx: Ctx, terms: Pick<VersionTerms, 'bundleHash' | 'auditRoot'>, models: ResolvedModels): PreviewCacheKeyInput {
  return {
    bundleHash: terms.bundleHash.toLowerCase(),
    auditRoot: terms.auditRoot.toLowerCase(),
    protocolId: PROTOCOL_ID,
    // the bundle's tools are generated from its manifest, which bundleHash already covers
    harnessDigest: protocolCommitment(ctx, null).digest,
    promptDigest: requireHarness(ctx).digest.promptDigest,
    validatorPromptHash: validatorPromptHash(),
    panel: models.panel.map((m) => ({ requested: m.requested, resolved: m.resolved, status: m.status })),
    validatorModel: models.validator.model,
  };
}

/** Upper estimate of wall time for a run (used against previewDeadline). */
export function estimateRunSec(ctx: Ctx, episodes: number, cached: boolean): number {
  if (cached) return 60;
  const rounds = Math.ceil(episodes / Math.max(1, ctx.cfg.preview.concurrency));
  return rounds * (ctx.cfg.preview.episodeTimeSec + 60) + 420;
}

// ------------------------------------------------------------------------------ quotes + payment
export interface IssuedQuote {
  quote: Record<string, unknown> & { feeUsdc: string; versionId: string; cached: boolean; validUntil: number; episodes: number };
  quoteHash: Hex;
  signature: Hex;
}

export async function quotePreview(ctx: Ctx, versionId: bigint, store = true): Promise<IssuedQuote> {
  const chain = requireChain(ctx);
  requireHarness(ctx);
  const terms = await chain.getVersion(versionId);
  if (!terms) throw new HttpError(404, `version ${versionId} not found on-chain`);
  const models = await resolveModelsCached(ctx);
  const key = previewCacheKey(cacheKeyInput(ctx, terms, models));
  const cached = !!getCacheEntry(ctx, key) || !!getStoredReport(ctx, versionId);
  const runnable = models.panel.filter((m) => m.status === 'run' && m.resolved).map((m) => m.resolved!);
  const nTasks = terms.taskCount + terms.auditTaskCount;
  const upload = loadUpload(ctx, terms.ciphertextHash);
  const cost: CostQuote = quotePreviewCost({
    models: cached ? [] : runnable,
    nTasks: cached ? 0 : nTasks,
    validatorModel: cached ? null : models.validator.model,
    validatorInputChars: upload?.validatorInputChars ?? null,
  });
  const minFee = abiHas(chain.abi, 'minPreviewFee') ? await chain.read<bigint>('minPreviewFee').catch(() => 0n) : 0n;
  const fee = feeUsdcBaseUnits(cost.quoteUsd, minFee);
  const episodes = cached ? 0 : runnable.length * nTasks;
  const now = Math.floor(Date.now() / 1000);
  const quote = {
    type: 'envmarket.preview-quote.v1',
    versionId: versionId.toString(),
    chainId: chain.chainId,
    market: chain.market.toLowerCase(),
    bundleHash: terms.bundleHash.toLowerCase(),
    auditRoot: terms.auditRoot.toLowerCase(),
    cacheKey: key,
    cached,
    episodes,
    models: models.panel.map((m) => m.resolved ?? `unavailable:${m.requested}`),
    validatorModel: models.validator.model,
    estimatedCostUsd: cost.estimatedCostUsd,
    quoteUsd: cost.quoteUsd,
    worstCaseUsd: cost.worstCaseUsd,
    tokenBoundEnforced: true,
    feeUsdc: fee.toString(),
    feeDecimals: 6,
    minPreviewFee: minFee.toString(),
    estimatedRunSec: estimateRunSec(ctx, episodes, cached),
    costModel: COST_MODEL_VERSION,
    issuedAt: now,
    validUntil: now + 900,
    signer: ctx.keys.account.address.toLowerCase(),
  };
  const quoteHash = sha256Hex(canonicalJson(quote));
  const signature = await ctx.keys.account.signMessage({ message: { raw: quoteHash } });
  const issued: IssuedQuote = { quote, quoteHash, signature };
  if (store) ctx.priv.put('quotes', quoteHash.slice(2), issued);
  return issued;
}

export interface Payment {
  fee: bigint;
  quoteHash: Hex;
  paidAt: bigint;
  deadline: bigint;
  quote: IssuedQuote | null;
}

/** On-chain paid preview request check. Null when the deployed ABI predates seller-paid previews. */
async function requirePaidPreview(ctx: Ctx, versionId: bigint, cachedNow: boolean): Promise<Payment | null> {
  const chain = requireChain(ctx);
  if (!abiHas(chain.abi, 'previewInfo')) return null;
  const [fee, paidAt, quoteHash, released, reclaimed] = await chain.read<[bigint, bigint, Hex, boolean, boolean]>('previewInfo', [versionId]);
  if (paidAt === 0n || reclaimed || released) {
    throw new HttpError(402, `no outstanding paid preview request on-chain (${paidAt === 0n ? 'never requested' : reclaimed ? 'reclaimed' : 'already released'}): GET /preview/quote/:versionId, then requestPreview(versionId, fee, quoteHash)`);
  }
  const issued = ctx.priv.get<IssuedQuote>('quotes', quoteHash.toLowerCase().slice(2));
  if (!issued || issued.quote.versionId !== versionId.toString()) throw new HttpError(402, `quoteHash ${quoteHash} was not issued by this service for version ${versionId}`);
  if (fee < BigInt(issued.quote.feeUsdc)) throw new HttpError(402, `paid preview fee ${fee} is below the quoted fee ${issued.quote.feeUsdc}`);
  if (Number(paidAt) > issued.quote.validUntil) throw new HttpError(402, `preview was paid at ${paidAt}, after the quote expired (${issued.quote.validUntil})`);
  const deadline = abiHas(chain.abi, 'previewDeadline') ? await chain.read<bigint>('previewDeadline', [versionId]) : 0n;
  if (deadline > 0n) {
    const need = estimateRunSec(ctx, cachedNow ? 0 : issued.quote.episodes, cachedNow);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now + BigInt(need) > deadline) throw new HttpError(409, `not enough time before previewDeadline ${deadline}: the run needs about ${need}s (reclaim and request again)`);
  }
  return { fee, quoteHash, paidAt, deadline, quote: issued };
}

// ------------------------------------------------------------------------------ preview
const inflight = new Map<string, Promise<StoredReport>>();
const lastFailure = new Map<string, { error: string; details: unknown; at: string }>();
const startedAt = new Map<string, string>();

/** Status of a preview run (for async callers polling GET /reports/:versionId). */
export function previewState(versionId: bigint): { state: 'running' | 'failed' | 'none'; startedAt?: string; error?: string; details?: unknown } {
  const key = reportKey(versionId);
  if (inflight.has(key)) return { state: 'running', startedAt: startedAt.get(key) };
  const f = lastFailure.get(key);
  return f ? { state: 'failed', error: f.error, details: f.details, startedAt: startedAt.get(key) } : { state: 'none' };
}

export async function previewVersion(ctx: Ctx, versionId: bigint): Promise<{ stored: StoredReport; cached: boolean }> {
  const existing = getStoredReport(ctx, versionId);
  if (existing) return { stored: existing, cached: true };
  const key = reportKey(versionId);
  const running = inflight.get(key);
  if (running) return { stored: await running, cached: true };
  startedAt.set(key, nowIso());
  lastFailure.delete(key);
  const p = runPreview(ctx, versionId)
    .catch((e) => {
      lastFailure.set(key, { error: errMsg(e), details: e instanceof HttpError ? e.details : null, at: nowIso() });
      ctx.priv.appendLog('previews', { versionId: versionId.toString(), status: 'failed', error: errMsg(e).slice(0, 300) });
      throw e;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return { stored: await p, cached: false };
}

/** Validate that a preview can run (used before rate limiting so bad requests don't burn quota). */
export async function previewPreconditions(ctx: Ctx, versionId: bigint): Promise<{ terms: VersionTerms; upload: UploadRecord; models: ResolvedModels; cacheKey: Hex; keyInput: PreviewCacheKeyInput; hit: PreviewCacheEntry | null; payment: Payment | null }> {
  if (ctx.sandbox.kind === 'unavailable') throw new HttpError(503, `sandbox ${ctx.sandbox.description}`);
  requireHarness(ctx);
  const chain = requireChain(ctx);
  const terms = await chain.getVersion(versionId);
  if (!terms) throw new HttpError(404, `version ${versionId} not found on-chain`);
  const upload = loadUpload(ctx, terms.ciphertextHash);
  if (!upload) throw new HttpError(409, `no uploaded bundle with ciphertextHash ${terms.ciphertextHash}; POST /seller/upload first`);
  const mism = termsMismatches(terms, upload);
  if (mism.length) throw new HttpError(409, 'on-chain version terms do not match the uploaded bundle', mism);
  if (!upload.preflight.buildOk) throw new HttpError(409, 'uploaded bundle failed the build/dependency preflight', upload.preflight);
  if (terms.reportHash !== ZERO32 && !getStoredReport(ctx, versionId)) throw new HttpError(409, `a different report (${terms.reportHash}) is already attached to version ${versionId}`);
  const models = await resolveModelsCached(ctx);
  const keyInput = cacheKeyInput(ctx, terms, models);
  const cacheKey = previewCacheKey(keyInput);
  const hit = getCacheEntry(ctx, cacheKey);
  const payment = await requirePaidPreview(ctx, versionId, !!hit);
  return { terms, upload, models, cacheKey, keyInput, hit, payment };
}

function reportFromEntry(ctx: Ctx, e: PreviewCacheEntry, terms: VersionTerms, versionId: bigint, payment: Payment | null): Report {
  const att = ctx.attestor.reportBlock();
  return reportSchema.parse({
    type: REPORT_TYPE,
    versionId: versionId.toString(),
    environmentVersion: e.environmentVersion,
    bundleHash: terms.bundleHash.toLowerCase(),
    ciphertextHash: terms.ciphertextHash.toLowerCase(),
    taskRoot: terms.taskRoot.toLowerCase(),
    auditRoot: terms.auditRoot.toLowerCase(),
    protocol: e.report.protocol,
    models: e.report.models,
    uncertainty: e.report.uncertainty,
    validator: e.report.validator,
    jobs: e.report.jobs,
    runtime: e.report.runtime,
    // reuse never upgrades trust: an unattested original run keeps the report unattested
    attestation: { ...att, kind: e.original.attestationKind === 'none-local-dev' ? 'none-local-dev' : att.kind },
    signer: ctx.keys.account.address,
    createdAt: nowIso(),
    cachedFrom: { originalRunAt: e.original.runAt, originalVersionId: e.original.versionId, originalChainId: e.original.chainId },
    inferenceCostUsd: 0,
    ...(payment ? { feePaidUsdc: payment.fee.toString() } : {}),
  });
}

interface FreshRun {
  episodes: EpisodeResult[];
  validator: ValidatorResult;
  inferenceCostUsd: number;
  toolsDigest: string | null;
  transcripts: Record<string, string>;
  harnessRuns: Array<{ split: string; exitCode: number | null; timedOut: boolean; records: number; summaries: unknown[]; stderrTail: string }>;
}

async function runFresh(ctx: Ctx, versionId: bigint, upload: UploadRecord, models: ResolvedModels): Promise<FreshRun> {
  const cfg = ctx.cfg;
  const h = requireHarness(ctx);
  const { dir: payloadDir, checks } = openBundle(ctx, upload, `pv${versionId}`);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) throw new HttpError(500, 'stored bundle failed integrity checks', bad);
  const auditDir = openAudit(ctx, upload, `pv${versionId}`);
  try {
    const dep = await prepareVenv(ctx.sandbox, ctx.cacheRoot, upload.requirementsLock);
    if (!dep.ok) throw new HttpError(500, 'dependency install failed', dep.log.slice(-1000));
    const tools = await bundleDigest(ctx, h, payloadDir, auditDir).catch((e) => {
      logger.warn('harness bundle digest failed', { error: errMsg(e) });
      return null;
    });
    const runnable = models.panel.map((m, mi) => ({ m, mi })).filter((x) => x.m.status === 'run' && x.m.resolved);
    const ids = runnable.map((x) => x.m.resolved!);
    const splits = [
      { split: 'purchased' as const, tasks: upload.taskIds, offset: 0, concurrency: cfg.preview.concurrency },
      ...(upload.auditTaskIds.length ? [{ split: 'audit' as const, tasks: upload.auditTaskIds, offset: upload.taskIds.length, concurrency: Math.max(1, Math.ceil(cfg.preview.concurrency / 3)) }] : []),
    ];
    const runs = ids.length
      ? await Promise.all(splits.map((s) => runHarness(ctx, h, { payloadDir, auditDir, split: s.split, tasks: s.tasks, models: ids, concurrency: s.concurrency, venv: dep.venv, label: `pv${versionId}-${s.split}` })))
      : [];
    const episodes: EpisodeResult[] = [];
    const transcripts: Record<string, string> = {};
    for (const x of runnable) {
      splits.forEach((s, si) => {
        const r = runs[si]!;
        s.tasks.forEach((task, ti) => {
          const meta = { jobId: `v${versionId}.m${x.mi}.j${s.offset + ti}`, requested: x.m.requested, provider: x.m.provider ?? cfg.llm.provider, set: s.split };
          const rec = r.records.find((rr) => rr.requestedModel === x.m.resolved && rr.taskId === task);
          episodes.push(rec ? toEpisodeResult(rec, meta) : missingEpisode(meta, x.m.resolved!, task, `harness reported no record (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}): ${r.stderrTail.slice(-300)}`));
        });
      });
    }
    for (const r of runs) Object.assign(transcripts, r.transcripts);

    const payloadFiles = collectFiles(payloadDir);
    const auditFiles = collectFiles(auditDir, 'audit/');
    const publicTexts = [upload.descriptionHash, upload.descriptionMdHash, upload.manifestHash].map((hh) => (hh ? ctx.blobs.getText(hh) : null)).filter((t): t is string => !!t);
    const idx = buildScreeningIndex({ files: [...payloadFiles, ...auditFiles], taskIds: [...upload.taskIds, ...upload.auditTaskIds], publicTexts });
    const validatorInput = buildValidatorInput({
      files: payloadFiles.filter((f) => !f.path.startsWith('solutions/')),
      descriptionJson: ctx.blobs.getText(upload.descriptionHash) ?? '{}',
      preflight: { dependencies: upload.preflight.dependencies.ok, graderImports: upload.preflight.imports?.ok, purchased: upload.preflight.purchased, auditTaskCount: upload.auditTaskIds.length, sandbox: upload.preflight.sandbox },
    });
    const client = llmClient(cfg.llm);
    const validator = await runValidator(models.validator.model ? client : null, models.validator.model, validatorInput, idx, { temperature: 0, seed: cfg.preview.seed, maxTokens: cfg.preview.maxTokens });
    const inferenceCostUsd = Math.round((episodes.reduce((s, e) => s + (e.usage.costUsd ?? 0), 0) + (validator.private.costUsd ?? 0)) * 1e6) / 1e6;
    return {
      episodes,
      validator,
      inferenceCostUsd,
      toolsDigest: tools?.toolsDigest ?? null,
      transcripts,
      harnessRuns: runs.map((r, i) => ({ split: splits[i]!.split, exitCode: r.exitCode, timedOut: r.timedOut, records: r.records.length, summaries: r.summaries, stderrTail: r.stderrTail })),
    };
  } finally {
    fs.rmSync(payloadDir, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
}

function freshReport(ctx: Ctx, versionId: bigint, terms: VersionTerms, upload: UploadRecord, models: ResolvedModels, fresh: FreshRun, payment: Payment | null): Report {
  const cfg = ctx.cfg;
  const { episodes, validator } = fresh;
  const commitment = protocolCommitment(ctx, fresh.toolsDigest);
  ctx.blobs.put(commitment.json); // preimage of protocol.harnessDigest, retrievable at /blobs/<digest>
  const reportModels = models.panel.map((m) => {
    const rs = episodes.filter((r) => r.requested === m.requested);
    const outcome = (set: 'purchased' | 'audit') => {
      const x = rs.filter((r) => r.set === set);
      const solved = x.filter((r) => r.solved).length;
      return { attempted: x.length, solved, pass1Rounded: pass1Rounded(solved, x.length) };
    };
    return { requested: m.requested, resolved: m.resolved, provider: m.provider, status: m.status, purchased: outcome('purchased'), audit: outcome('audit'), infraFailures: rs.filter((r) => r.status === 'infra_failure').length };
  });
  const base: Record<string, unknown> = {
    type: REPORT_TYPE,
    versionId: versionId.toString(),
    environmentVersion: upload.environmentVersion,
    bundleHash: terms.bundleHash.toLowerCase(),
    ciphertextHash: terms.ciphertextHash.toLowerCase(),
    taskRoot: terms.taskRoot.toLowerCase(),
    auditRoot: terms.auditRoot.toLowerCase(),
    protocol: {
      id: PROTOCOL_ID,
      harnessDigest: commitment.digest,
      promptDigest: requireHarness(ctx).digest.promptDigest,
      decoding: { temperature: cfg.preview.temperature, seed: cfg.preview.seed, maxTokens: cfg.preview.maxTokens },
      actionBudget: cfg.preview.actionBudget,
      timeBudgetSec: cfg.preview.episodeTimeSec,
      successRule: SUCCESS_RULE_ALL_TESTS,
      ...(fresh.toolsDigest ? { toolsDigest: fresh.toolsDigest } : {}),
      tokenBoundEnforced: models.panel.every((m) => m.status !== 'run' || !m.resolved || tokenBudgetFor(m.resolved) !== null),
    },
    models: reportModels,
    uncertainty:
      `n=${upload.taskIds.length} purchased and n=${upload.auditTaskIds.length} audit tasks, one episode per task per model (pass@1); ` +
      'rounding to 5 percentage points hides little at this size and a single task changes a score by ' +
      `${Math.round(100 / Math.max(1, upload.taskIds.length))} points. Temperature 0 with a fixed seed does not guarantee identical provider outputs. ` +
      disclosures(ctx, cfg.llm.provider).slice(1, 2).join(' ') +
      [
        ...models.panel.filter((m) => m.status === 'run' && m.reason).map((m) => ` Model note (${m.requested}): ${m.reason}.`),
        models.validator.reason ? ` Validator note: ${models.validator.reason}.` : '',
      ].join(''),
    validator: { model: validator.model, promptVersion: validator.promptVersion, promptHash: validator.promptHash, explanation: validator.explanation, screening: validator.screening },
    jobs: episodes.map((r) => ({ jobId: r.jobId, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status === 'infra_failure' ? 'infra_failure' : 'succeeded' })),
    runtime: { imageDigest: upload.imageDigest, sandbox: ctx.sandbox.description, network: 'none' },
    attestation: ctx.attestor.reportBlock(),
    signer: ctx.keys.account.address,
    createdAt: nowIso(),
    inferenceCostUsd: fresh.inferenceCostUsd,
    ...(payment ? { feePaidUsdc: payment.fee.toString() } : {}),
  };
  return reportSchema.parse(base);
}

async function runPreview(ctx: Ctx, versionId: bigint): Promise<StoredReport> {
  const { terms, upload, models, cacheKey, keyInput, hit, payment } = await previewPreconditions(ctx, versionId);
  const chain = requireChain(ctx);
  const t0 = Date.now();
  logger.info('preview start', { versionId, uploadId: upload.uploadId, cacheKey, cacheHit: !!hit, fee: payment?.fee });

  let report: Report;
  let episodes: EpisodeResult[];
  let validatorPrivate: unknown;
  let inferenceCostUsd = 0;
  let runModels = models;
  let fresh: FreshRun | null = null;
  if (hit) {
    report = reportFromEntry(ctx, hit, terms, versionId, payment);
    episodes = hit.episodes;
    validatorPrivate = hit.validatorPrivate;
    runModels = hit.models;
  } else {
    fresh = await runFresh(ctx, versionId, upload, models);
    episodes = fresh.episodes;
    validatorPrivate = fresh.validator.private;
    inferenceCostUsd = fresh.inferenceCostUsd;
    report = freshReport(ctx, versionId, terms, upload, models, fresh, payment);
  }

  const reportJson = serializeReport(report);
  const rh = computeReportHash(reportJson);
  const signature = await signPreviewReport(ctx.keys.account, domainOf(ctx), { versionId, bundleHash: terms.bundleHash, reportHash: rh });
  ctx.blobs.put(reportJson);
  const stored: StoredReport = {
    versionId: versionId.toString(),
    protocolId: PROTOCOL_ID,
    report,
    reportJson,
    reportHash: rh,
    signature,
    signer: ctx.keys.account.address,
    attestationToken: null,
    attachTx: null,
    attachError: null,
    cacheKey,
    reusedCache: !!hit,
    inferenceCostUsd,
    feePaidUsdc: payment ? payment.fee.toString() : null,
    quoteHash: payment?.quoteHash ?? null,
    createdAt: report.createdAt,
  };
  ctx.priv.put('reports', reportKey(versionId), stored);
  // private, unrounded per-task outcomes + usage/cost for this version (the verifier reads these)
  ctx.priv.put('runs', reportKey(versionId), {
    versionId: versionId.toString(),
    protocolId: PROTOCOL_ID,
    uploadId: upload.uploadId,
    cacheKey,
    reusedCache: !!hit,
    models: runModels,
    episodes,
    validator: validatorPrivate,
    inferenceCostUsd,
    feePaidUsdc: stored.feePaidUsdc,
    toolsDigest: fresh?.toolsDigest ?? null,
    harnessRuns: fresh?.harnessRuns ?? null,
    durationMs: Date.now() - t0,
  });
  if (fresh && Object.keys(fresh.transcripts).length) ctx.priv.put('transcripts', reportKey(versionId), fresh.transcripts);

  // attach immediately after signing (releases the escrowed preview fee)
  if (ctx.cfg.submitTxs) {
    try {
      if (!(await chain.hasRole('isRunner'))) throw new Error(`signer ${ctx.keys.account.address} is not a registered runner`);
      const v = await chain.getVersion(versionId);
      if (v && v.reportHash === ZERO32) {
        const { hash } = await chain.write('attachReport', [versionId, rh, signature], `attachReport(v${versionId})`);
        stored.attachTx = hash;
      } else if (!(v && v.reportHash.toLowerCase() === rh)) stored.attachError = `another report is attached: ${v?.reportHash}`;
    } catch (e) {
      stored.attachError = errMsg(e).slice(0, 500);
      logger.warn('attachReport failed', { versionId, error: stored.attachError });
    }
  }
  stored.attestationToken = await ctx.attestor.tokenFor(canonicalJson({ type: 'envmarket.report.attestation.v1', versionId: versionId.toString(), reportHash: rh }));
  ctx.priv.put('reports', reportKey(versionId), stored);

  if (!hit && !report.models.some((m) => m.infraFailures > 0) && report.models.some((m) => m.status === 'run')) {
    const entry = await signEntry(ctx, {
      type: 'envmarket.preview-cache.v1',
      key: cacheKey,
      keyInput,
      environmentVersion: report.environmentVersion,
      original: {
        versionId: versionId.toString(),
        chainId: chain.chainId,
        market: chain.market.toLowerCase(),
        runAt: report.createdAt,
        reportHash: rh,
        signer: ctx.keys.account.address,
        attestationKind: report.attestation.kind,
        appId: report.attestation.appId,
        sandbox: report.runtime.sandbox,
      },
      report: { protocol: report.protocol, models: report.models, uncertainty: report.uncertainty, validator: report.validator, jobs: report.jobs, runtime: report.runtime },
      models,
      episodes,
      validatorPrivate,
      spec: protocolSpec(ctx),
      producer: ctx.keys.account.address,
    });
    putCacheEntry(ctx, entry);
    ctx.priv.appendLog('preview-cache', { kind: 'store', key: cacheKey, versionId: versionId.toString(), inferenceCostUsd });
  }
  logger.info('preview done', { versionId, reportHash: rh, reusedCache: !!hit, jobs: report.jobs.length, inferenceCostUsd, ms: Date.now() - t0 });
  return stored;
}

/** Attach a stored report that was produced with SUBMIT_TXS off, or retry a failed attach. */
export async function attachStoredReport(ctx: Ctx, versionId: bigint): Promise<StoredReport> {
  const stored = getStoredReport(ctx, versionId);
  if (!stored) throw new HttpError(404, 'no report for this version');
  const chain = requireChain(ctx);
  const v = await chain.getVersion(versionId);
  if (v && v.reportHash === ZERO32) {
    const { hash } = await chain.write('attachReport', [versionId, stored.reportHash, stored.signature], `attachReport(v${versionId})`);
    stored.attachTx = hash;
    stored.attachError = null;
    ctx.priv.put('reports', reportKey(versionId, stored.protocolId), stored);
  }
  return stored;
}

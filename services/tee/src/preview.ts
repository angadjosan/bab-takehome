/**
 * Preview runner: POST /preview/:versionId.
 *
 * Reads the version's on-chain terms, requires them to match the uploaded bundle, runs the
 * reference panel through the real harness (every model × every purchased and audit task, one
 * episode each), runs the validator, builds report.json (shared schema), signs the EIP-712
 * PreviewReport and (SUBMIT_TXS) submits attachReport. One report per (versionId, protocol id).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  canonicalJson,
  pass1Rounded,
  REPORT_TYPE,
  reportHash as computeReportHash,
  serializeReport,
  signPreviewReport,
  SUCCESS_RULE_ALL_TESTS,
  type Report,
} from '@envmarket/shared';
import type { Hex } from 'viem';
import { loadUpload, openAudit, openBundle, type UploadRecord } from './bundle.ts';
import { ZERO32, type VersionTerms } from './chain.ts';
import { domainOf, requireChain, type Ctx } from './context.ts';
import { AGENT_TOOLS, EXTRA_LLM_CALLS, HARNESS_ID, harnessDigest, MAX_IDLE_TURNS, promptDigest, runEpisode, TOOL_RESULT_MAX_CHARS, type EpisodeResult, type EpisodeSpec } from './harness.ts';
import { errMsg, logger } from './log.ts';
import { llmClient, resolveModels, type ResolvedModels } from './models.ts';
import { prepareVenv } from './sandbox.ts';
import { mapLimit, nowIso } from './util.ts';
import { buildScreeningIndex, buildValidatorInput, collectFiles, runValidator, SCREENING_RULES, validatorPromptHash, VALIDATOR_PROMPT_VERSION, type ValidatorResult } from './validator.ts';

export const PROTOCOL_ID = 'envmarket.preview.v1';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The public, precommitted protocol (hashed into protocol.harnessDigest). */
export function protocolSpec(ctx: Ctx): Record<string, unknown> {
  const p = ctx.cfg.preview;
  return {
    id: PROTOCOL_ID,
    harness: HARNESS_ID,
    tools: AGENT_TOOLS.map((t) => t.function.name),
    decoding: { temperature: p.temperature, seed: p.seed, maxTokens: p.maxTokens },
    actionBudget: p.actionBudget,
    timeBudgetSec: p.episodeTimeSec,
    maxModelCalls: p.actionBudget + EXTRA_LLM_CALLS,
    maxIdleTurns: MAX_IDLE_TURNS,
    toolResultMaxChars: TOOL_RESULT_MAX_CHARS,
    taskSelection: 'every purchased task and every audit task, exactly one episode each (pass@1); no retries, no best-of',
    successRule: SUCCESS_RULE_ALL_TESTS + ' (and the episode ended by submit)',
    failures: 'budget exhaustion, timeout, no submit and infrastructure failures all count as attempted and not solved; infrastructure failures are also reported per model',
    rounding: 'pass@1 rounded to the nearest 5 percentage points (half up), purchased and audit reported separately',
    panel: { requested: ['GLM 5.3', 'Kimi K3', 'Qwen 3.8'], resolution: 'newest chat model with tool calling per family on the provider at run time; unavailable models are reported as unavailable, never substituted' },
    reproducibility: {
      repeatCount: 1,
      deterministicRegradeTolerance: 0,
      deterministicRegrade: 'the stored final workspace of each original episode is re-graded with the hidden tests; the outcome must match exactly',
      llmRerunTolerancePp: 5,
      llmRerun: 'each masked task is re-run once per model under this protocol; per model, |rerun pass rate - original pass rate| over the masked tasks must be <= 5 percentage points (at this population size a single changed outcome exceeds it)',
    },
    validator: { promptVersion: VALIDATOR_PROMPT_VERSION, promptHash: validatorPromptHash(), screening: SCREENING_RULES },
    sandbox: 'agent phase and grade phase run in separate offline sandboxes; the agent phase never contains hidden tests or solutions',
  };
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
  createdAt: string;
}

const reportKey = (versionId: bigint) => `v${versionId}-${PROTOCOL_ID}`;

export function getStoredReport(ctx: Ctx, versionId: bigint): StoredReport | null {
  return ctx.priv.get<StoredReport>('reports', reportKey(versionId));
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
      : 'Runner, relay and verifier execute inside an EigenCompute TEE (Intel TDX); the signer is bound to the attested app by the runtime attestation token.',
    provider === 'ollama'
      ? 'Inference ran on a local Ollama endpoint (harness check only); the GLM 5.3 / Kimi K3 / Qwen 3.8 panel was NOT run and is reported as unavailable.'
      : `The inference provider (${provider}) receives task statements and workspace file contents during preview episodes and receives the environment files when the validator runs; the TEE protects keys, hidden tests, grading and signing, not model inference.`,
    'A signature identifies the report signer; it does not prove the findings are true. pass@1 on reference models does not establish training value.',
  ];
}

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
export async function previewPreconditions(ctx: Ctx, versionId: bigint): Promise<{ terms: VersionTerms; upload: UploadRecord }> {
  if (ctx.sandbox.kind === 'unavailable') throw new HttpError(503, `sandbox ${ctx.sandbox.description}`);
  const chain = requireChain(ctx);
  const terms = await chain.getVersion(versionId);
  if (!terms) throw new HttpError(404, `version ${versionId} not found on-chain`);
  const upload = loadUpload(ctx, terms.ciphertextHash);
  if (!upload) throw new HttpError(409, `no uploaded bundle with ciphertextHash ${terms.ciphertextHash}; POST /seller/upload first`);
  const mism = termsMismatches(terms, upload);
  if (mism.length) throw new HttpError(409, 'on-chain version terms do not match the uploaded bundle', mism);
  if (!upload.preflight.buildOk) throw new HttpError(409, 'uploaded bundle failed the build/dependency preflight', upload.preflight);
  if (terms.reportHash !== ZERO32 && !getStoredReport(ctx, versionId)) throw new HttpError(409, `a different report (${terms.reportHash}) is already attached to version ${versionId}`);
  return { terms, upload };
}

async function runPreview(ctx: Ctx, versionId: bigint): Promise<StoredReport> {
  const { terms, upload } = await previewPreconditions(ctx, versionId);
  const chain = requireChain(ctx);
  const cfg = ctx.cfg;
  const t0 = Date.now();
  logger.info('preview start', { versionId, uploadId: upload.uploadId });

  const models: ResolvedModels = await resolveModels(cfg.llm);
  const client = llmClient(cfg.llm);
  const { dir: payloadDir, checks } = openBundle(ctx, upload, `pv${versionId}`);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) throw new HttpError(500, 'stored bundle failed integrity checks', bad);
  const auditDir = openAudit(ctx, upload, `pv${versionId}`);
  try {
    const dep = await prepareVenv(ctx.sandbox, ctx.cacheRoot, upload.requirementsLock);
    if (!dep.ok) throw new HttpError(500, 'dependency install failed', dep.log.slice(-1000));

    // ------------------------------------------------------------ schedule jobs
    const specs: Array<{ spec: EpisodeSpec; inputs: { venv: string; payloadDir: string; taskSourceDir: string } }> = [];
    models.panel.forEach((m, mi) => {
      if (m.status !== 'run' || !m.resolved) return;
      const tasks = [
        ...upload.taskIds.map((t) => ({ t, set: 'purchased' as const, dir: path.join(payloadDir, 'tasks') })),
        ...upload.auditTaskIds.map((t) => ({ t, set: 'audit' as const, dir: auditDir })),
      ];
      tasks.forEach((x, ti) =>
        specs.push({
          spec: {
            jobId: `v${versionId}.m${mi}.j${ti}`,
            requested: m.requested,
            model: m.resolved!,
            provider: m.provider ?? cfg.llm.provider,
            taskId: x.t,
            set: x.set,
            seed: cfg.preview.seed,
            temperature: cfg.preview.temperature,
            maxTokens: cfg.preview.maxTokens,
            actionBudget: cfg.preview.actionBudget,
            timeBudgetSec: cfg.preview.episodeTimeSec,
          },
          inputs: { venv: dep.venv, payloadDir, taskSourceDir: x.dir },
        }),
      );
    });
    const results: EpisodeResult[] = await mapLimit(specs, cfg.preview.concurrency, (s) => runEpisode(ctx, client, s.spec, s.inputs));

    // ------------------------------------------------------------ validator
    const payloadFiles = collectFiles(payloadDir);
    const auditFiles = collectFiles(auditDir, 'audit/');
    const idx = buildScreeningIndex({ files: [...payloadFiles, ...auditFiles], taskIds: [...upload.taskIds, ...upload.auditTaskIds] });
    const descriptionJson = ctx.blobs.getText(upload.descriptionHash) ?? '{}';
    const validatorInput = buildValidatorInput({
      files: payloadFiles.filter((f) => !f.path.startsWith('solutions/')),
      descriptionJson,
      preflight: { dependencies: upload.preflight.dependencies.ok, graderImports: upload.preflight.imports?.ok, purchased: upload.preflight.purchased, auditTaskCount: upload.auditTaskIds.length, sandbox: upload.preflight.sandbox },
    });
    const validator: ValidatorResult = await runValidator(models.validator.model ? client : null, models.validator.model, validatorInput, idx, {
      temperature: 0,
      seed: cfg.preview.seed,
      maxTokens: cfg.preview.maxTokens,
    });

    // ------------------------------------------------------------ report
    const spec = protocolSpec(ctx);
    const reportModels = models.panel.map((m) => {
      const rs = results.filter((r) => r.requested === m.requested);
      const outcome = (set: 'purchased' | 'audit') => {
        const x = rs.filter((r) => r.set === set);
        const solved = x.filter((r) => r.solved).length;
        return { attempted: x.length, solved, pass1Rounded: pass1Rounded(solved, x.length) };
      };
      return {
        requested: m.requested,
        resolved: m.resolved,
        provider: m.provider,
        status: m.status,
        purchased: outcome('purchased'),
        audit: outcome('audit'),
        infraFailures: rs.filter((r) => r.status === 'infra_failure').length,
      };
    });
    const provider = cfg.llm.provider;
    const report: Report = {
      type: REPORT_TYPE,
      versionId: versionId.toString(),
      environmentVersion: upload.environmentVersion,
      bundleHash: terms.bundleHash.toLowerCase(),
      ciphertextHash: terms.ciphertextHash.toLowerCase(),
      taskRoot: terms.taskRoot.toLowerCase(),
      auditRoot: terms.auditRoot.toLowerCase(),
      protocol: {
        id: PROTOCOL_ID,
        harnessDigest: harnessDigest(spec),
        promptDigest: promptDigest(),
        decoding: { temperature: cfg.preview.temperature, seed: cfg.preview.seed, maxTokens: cfg.preview.maxTokens },
        actionBudget: cfg.preview.actionBudget,
        timeBudgetSec: cfg.preview.episodeTimeSec,
        successRule: SUCCESS_RULE_ALL_TESTS,
      },
      models: reportModels,
      uncertainty:
        `n=${upload.taskIds.length} purchased and n=${upload.auditTaskIds.length} audit tasks, one episode per task per model (pass@1); ` +
        'rounding to 5 percentage points hides little at this size and a single task changes a score by ' +
        `${Math.round(100 / Math.max(1, upload.taskIds.length))} points. Temperature 0 with a fixed seed does not guarantee identical provider outputs. ` +
        disclosures(ctx, provider).slice(1, 2).join(' '),
      validator: {
        model: validator.model,
        promptVersion: validator.promptVersion,
        promptHash: validator.promptHash,
        explanation: validator.explanation,
        screening: validator.screening,
      },
      jobs: results.map((r) => ({ jobId: r.jobId, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status === 'infra_failure' ? 'infra_failure' : 'succeeded' })),
      runtime: { imageDigest: upload.imageDigest, sandbox: ctx.sandbox.description, network: 'none' },
      attestation: ctx.attestor.reportBlock(),
      signer: ctx.keys.account.address,
      createdAt: nowIso(),
    };
    const reportJson = serializeReport(report);
    const rh = computeReportHash(reportJson);
    const signature = await signPreviewReport(ctx.keys.account, domainOf(ctx), { versionId, bundleHash: terms.bundleHash, reportHash: rh });
    ctx.blobs.put(reportJson);
    const attestationToken = await ctx.attestor.tokenFor(canonicalJson({ type: 'envmarket.report.attestation.v1', versionId: versionId.toString(), reportHash: rh }));
    const stored: StoredReport = {
      versionId: versionId.toString(),
      protocolId: PROTOCOL_ID,
      report,
      reportJson,
      reportHash: rh,
      signature,
      signer: ctx.keys.account.address,
      attestationToken,
      attachTx: null,
      attachError: null,
      createdAt: report.createdAt,
    };
    // private, unrounded per-task outcomes (never published)
    ctx.priv.put('runs', reportKey(versionId), {
      versionId: versionId.toString(),
      protocolId: PROTOCOL_ID,
      uploadId: upload.uploadId,
      models,
      episodes: results,
      validator,
      spec,
      durationMs: Date.now() - t0,
    });
    ctx.priv.put('reports', reportKey(versionId), stored);

    if (cfg.submitTxs) {
      try {
        if (!(await chain.hasRole('isRunner'))) throw new Error(`signer ${ctx.keys.account.address} is not a registered runner`);
        const fresh = await chain.getVersion(versionId);
        if (fresh && fresh.reportHash === ZERO32) {
          const { hash } = await chain.write('attachReport', [versionId, rh, signature], `attachReport(v${versionId})`);
          stored.attachTx = hash;
        } else if (fresh && fresh.reportHash.toLowerCase() === rh) {
          stored.attachError = null;
        } else stored.attachError = `another report is attached: ${fresh?.reportHash}`;
      } catch (e) {
        stored.attachError = errMsg(e).slice(0, 500);
        logger.warn('attachReport failed', { versionId, error: stored.attachError });
      }
      ctx.priv.put('reports', reportKey(versionId), stored);
    }
    logger.info('preview done', { versionId, reportHash: rh, jobs: results.length, ms: Date.now() - t0 });
    return stored;
  } finally {
    fs.rmSync(payloadDir, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
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
    ctx.priv.put('reports', reportKey(versionId), stored);
  }
  return stored;
}

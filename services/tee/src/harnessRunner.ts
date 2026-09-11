/**
 * Reference harness client: `harness/envmarket_coding` (Prime Intellect `verifiers` 0.3.1), run as a
 * subprocess per harness/README.md "Integration contract for the TEE". It replaces the former
 * TypeScript agent loop.
 *
 *   python -m envmarket_coding.run --digest [--bundle <payload>]           → harness/prompt/tools digests
 *   python -m envmarket_coding.run --bundle … --split … --model … --out …    → one JSON line per episode + summaries
 *   python -m envmarket_coding.run --regrade <episodes.jsonl> --bundle …     → deterministic re-grade
 *
 * The harness runs the agent loop (OpenAI-compatible calls to the provider) and executes seller code
 * only inside its sandbox, with the same modes as ours: `--sandbox docker` (pinned
 * python:3.12-slim) or `--sandbox unshare` with our seccomp launcher `runtime/netdeny.py`. It reuses
 * the grader venv built by `prepareVenv`. Its child env never contains key material (MNEMONIC,
 * *_PK, *_SK, KMS_*). The provider key is passed under a dedicated variable. Plaintext outputs
 * (`--out` records with final workspaces, transcripts) are read back and deleted, and callers keep
 * them only in the encrypted private store.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from '@envmarket/shared';
import type { ServiceConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { usageCostUsd } from './cost.ts';
import { errMsg, logger } from './log.ts';
import { NETDENY, scratchDir, type SandboxInfo } from './sandbox.ts';

export interface HarnessDigest {
  type: 'digest';
  harnessId: string;
  harnessDigest: string;
  promptDigest: string;
  verifiersVersion: string;
  protocol: Record<string, unknown>;
  toolsDigest?: string;
  toolSource?: string;
  environmentId?: string;
  tools?: unknown[];
}

export interface HarnessInfo {
  dir: string;
  python: string;
  digest: HarnessDigest;
}

/** One `"type": "episode"` line (harness/README.md "Episode record"). */
export interface HarnessRecord {
  type: 'episode';
  episodeId: string;
  environmentId?: string;
  taskId: string;
  split: 'purchased' | 'audit';
  requestedModel: string;
  model?: string;
  servedModels?: string[];
  status: 'succeeded' | 'failed' | 'infra_failure';
  solved: boolean;
  score: number;
  termination?: string | null;
  stopCondition?: string | null;
  actions?: Array<{ type: string; path?: string; ok: boolean }>;
  llmCalls?: number;
  usage?: { prompt: number; completion: number };
  seedSent?: boolean;
  startedAt: string;
  finishedAt: string;
  grade?: Record<string, any> | null;
  finalFiles?: Record<string, string>;
  transcriptHash?: string;
  error?: string | null;
}

/** Same shape the TEE has always stored per episode (reports, cache entries, verifier). */
export interface GradeSummary {
  score: number;
  success: boolean;
  termination: string;
  passed: number;
  failed: number;
  collected: number | null;
  allHiddenTestsPassed: boolean;
  timedOut: boolean;
  editedFiles: string[];
  gradedTreeDigest: string | null;
}

export interface EpisodeResult {
  jobId: string;
  requested: string;
  model: string;
  provider: string;
  taskId: string;
  set: 'purchased' | 'audit';
  status: 'succeeded' | 'failed' | 'infra_failure';
  solved: boolean;
  termination: string | null;
  grade: GradeSummary | null;
  actions: Array<{ type: string; path?: string; ok: boolean }>;
  llmCalls: number;
  servedModels: string[];
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number; costUsd: number | null };
  /** retained for record compatibility; the harness has no cumulative token stop (always false) */
  tokenBudgetExceeded: boolean;
  seedSent: boolean;
  startedAt: string;
  finishedAt: string;
  error: string | null;
  finalFiles: Record<string, string>;
  transcriptHash: string;
  harnessEpisodeId?: string;
  stopCondition?: string | null;
}

export interface EpisodeMeta {
  jobId: string;
  requested: string;
  provider: string;
  set: 'purchased' | 'audit';
}

// ------------------------------------------------------------------------------ discovery
export function locateHarness(cfg: ServiceConfig): { dir: string; python: string } | null {
  const e = cfg.rawEnv;
  const dirs = [e.HARNESS_DIR, cfg.repoRoot ? path.join(cfg.repoRoot, 'harness', 'envmarket_coding') : null, '/app/harness/envmarket_coding'].filter((d): d is string => !!d);
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'envmarket_coding', 'run.py')));
  if (!dir) return null;
  const python = e.HARNESS_PYTHON ?? [path.join(dir, '.venv', 'bin', 'python'), '/opt/harness-venv/bin/python'].find((p) => fs.existsSync(p)) ?? 'python3.12';
  return { dir: path.resolve(dir), python };
}

const SECRET_ENV = /^(MNEMONIC|KMS_.*|.*_PK|.*_SK|.*PRIVATE_KEY.*)$/;

export function harnessEnv(cfg: ServiceConfig, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
  return { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', ...extra };
}

interface PyRun {
  lines: Array<Record<string, any>>;
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

function runPy(h: { dir: string; python: string }, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<PyRun> {
  return new Promise((resolve) => {
    const child = spawn(h.python, ['-m', 'envmarket_coding.run', ...args], { cwd: h.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: Array<Record<string, any>> = [];
    let buf = '';
    let stderr = '';
    const take = (l: string) => {
      const s = l.trim();
      if (!s) return;
      try {
        lines.push(JSON.parse(s) as Record<string, any>);
      } catch {
        /* stdout is JSON lines only; ignore stray output */
      }
    };
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        take(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-16_000)));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => (stderr += `\nspawn error: ${errMsg(e)}`));
    child.on('close', (code) => {
      clearTimeout(t);
      take(buf);
      resolve({ lines, code, stderr, timedOut });
    });
  });
}

export async function loadHarness(cfg: ServiceConfig): Promise<HarnessInfo | null> {
  const loc = locateHarness(cfg);
  if (!loc) return null;
  const r = await runPy(loc, ['--digest', '--action-budget', String(cfg.preview.actionBudget), '--time-budget', String(cfg.preview.episodeTimeSec)], harnessEnv(cfg), 180_000);
  const d = r.lines.find((l) => l.type === 'digest') as HarnessDigest | undefined;
  if (!d) throw new Error(`harness --digest failed (exit ${r.code}): ${r.stderr.slice(-600)}`);
  return { ...loc, digest: d };
}

/** Bundle-specific digest (toolsDigest: the exact tool interface generated from the manifest). */
export async function bundleDigest(ctx: Ctx, h: HarnessInfo, payloadDir: string, auditDir: string): Promise<HarnessDigest> {
  const r = await runPy(h, ['--digest', '--bundle', payloadDir, '--audit-dir', auditDir, '--action-budget', String(ctx.cfg.preview.actionBudget), '--time-budget', String(ctx.cfg.preview.episodeTimeSec)], harnessEnv(ctx.cfg), 180_000);
  const d = r.lines.find((l) => l.type === 'digest') as HarnessDigest | undefined;
  if (!d) throw new Error(`harness --digest --bundle failed (exit ${r.code}): ${r.stderr.slice(-600)}`);
  return d;
}

export function sandboxArgs(sb: SandboxInfo): string[] {
  if (sb.kind === 'docker') return ['--sandbox', 'docker', '--image', sb.image!];
  if (sb.kind === 'linux-root') return ['--sandbox', 'unshare', ...(sb.seccompNetDeny ? ['--netdeny', NETDENY] : []), '--grader-python', 'python3'];
  throw new Error(`sandbox ${sb.description}`);
}

function harnessScratch(ctx: Ctx, label: string): string {
  const s = scratchDir(ctx.workRoot, label);
  fs.chmodSync(s, 0o711); // sandboxed uids traverse (not list) into the harness work dir
  return s;
}

// ------------------------------------------------------------------------------ runs
export interface HarnessRun {
  records: HarnessRecord[];
  summaries: Array<Record<string, unknown>>;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  /** full transcripts by file name (private: callers store them encrypted) */
  transcripts: Record<string, string>;
}

export async function runHarness(
  ctx: Ctx,
  h: HarnessInfo,
  a: { payloadDir: string; auditDir: string; split: 'purchased' | 'audit'; tasks?: string[]; models: string[]; concurrency: number; venv: string; label: string },
): Promise<HarnessRun> {
  const scratch = harnessScratch(ctx, `harness-${a.label}`);
  const out = path.join(scratch, 'episodes.jsonl');
  const tx = path.join(scratch, 'transcripts');
  const p = ctx.cfg.preview;
  const args = [
    '--bundle', a.payloadDir, '--split', a.split, '--audit-dir', a.auditDir,
    ...(a.tasks?.length ? ['--tasks', a.tasks.join(',')] : []),
    ...a.models.flatMap((m) => ['--model', m]),
    '--seed', String(p.seed), '--temperature', String(p.temperature), '--max-tokens', String(p.maxTokens),
    '--action-budget', String(p.actionBudget), '--time-budget', String(p.episodeTimeSec), '--concurrency', String(Math.max(1, a.concurrency)),
    ...sandboxArgs(ctx.sandbox), '--venv', a.venv, '--work-dir', path.join(scratch, 'work'),
    '--base-url', ctx.cfg.llm.baseUrl, '--api-key-env', 'HARNESS_LLM_API_KEY',
    '--out', out, '--transcripts', tx,
  ];
  const key = ctx.cfg.llm.apiKey ?? (ctx.cfg.llm.provider === 'ollama' ? 'ollama-local' : '');
  const n = a.models.length * Math.max(1, a.tasks?.length ?? 20);
  const timeoutMs = ((Math.ceil(n / Math.max(1, a.concurrency)) + 1) * (p.episodeTimeSec + 180) + 900) * 1000;
  const t0 = Date.now();
  const r = await runPy(h, args, harnessEnv(ctx.cfg, { HARNESS_LLM_API_KEY: key, LLM_BASE_URL: ctx.cfg.llm.baseUrl }), timeoutMs);
  const transcripts: Record<string, string> = {};
  try {
    if (fs.existsSync(tx)) for (const f of fs.readdirSync(tx)) transcripts[f] = fs.readFileSync(path.join(tx, f), 'utf8');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const records = r.lines.filter((l) => l.type === 'episode') as HarnessRecord[];
  if (r.code !== 0 || r.timedOut) logger.warn('harness run ended abnormally', { label: a.label, exit: r.code, timedOut: r.timedOut, records: records.length, stderr: r.stderr.slice(-400) });
  logger.info('harness run done', { label: a.label, split: a.split, models: a.models.length, records: records.length, ms: Date.now() - t0 });
  return { records, summaries: r.lines.filter((l) => l.type === 'summary'), exitCode: r.code, timedOut: r.timedOut, stderrTail: r.stderr.slice(-2000), transcripts };
}

export function toEpisodeResult(rec: HarnessRecord, meta: EpisodeMeta): EpisodeResult {
  const g = rec.grade;
  const usage = { promptTokens: rec.usage?.prompt ?? 0, completionTokens: rec.usage?.completion ?? 0, cachedPromptTokens: 0, costUsd: null as number | null };
  usage.costUsd = usageCostUsd(rec.requestedModel, usage); // list price (the harness reports no cached-token split)
  return {
    jobId: meta.jobId,
    requested: meta.requested,
    model: rec.requestedModel,
    provider: meta.provider,
    taskId: rec.taskId,
    set: meta.set,
    status: rec.status,
    solved: !!rec.solved && rec.status !== 'infra_failure',
    termination: rec.termination ?? null,
    grade: g
      ? {
          score: Number(g.score),
          success: !!g.success,
          termination: String(g.termination),
          passed: Number(g.passed ?? 0),
          failed: Number(g.failed ?? 0),
          collected: typeof g.collected === 'number' ? g.collected : null,
          allHiddenTestsPassed: !!g.allHiddenTestsPassed,
          timedOut: !!g.timedOut,
          editedFiles: Array.isArray(g.editedFiles) ? g.editedFiles : [],
          gradedTreeDigest: g.gradedTreeDigest ?? null,
        }
      : null,
    actions: rec.actions ?? [],
    llmCalls: rec.llmCalls ?? 0,
    servedModels: rec.servedModels ?? [],
    usage,
    tokenBudgetExceeded: false,
    seedSent: rec.seedSent ?? true,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    error: rec.error ?? null,
    finalFiles: rec.finalFiles ?? {},
    transcriptHash: rec.transcriptHash ?? sha256Hex(''),
    harnessEpisodeId: rec.episodeId,
    stopCondition: rec.stopCondition ?? null,
  };
}

/** An episode the harness never reported (crash, timeout, non-zero exit): attempted, not solved. */
export function missingEpisode(meta: EpisodeMeta, model: string, taskId: string, error: string): EpisodeResult {
  const now = new Date().toISOString();
  return {
    jobId: meta.jobId,
    requested: meta.requested,
    model,
    provider: meta.provider,
    taskId,
    set: meta.set,
    status: 'infra_failure',
    solved: false,
    termination: null,
    grade: null,
    actions: [],
    llmCalls: 0,
    servedModels: [],
    usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, costUsd: 0 },
    tokenBudgetExceeded: false,
    seedSent: false,
    startedAt: now,
    finishedAt: now,
    error: error.slice(0, 1000),
    finalFiles: {},
    transcriptHash: sha256Hex(''),
  };
}

// ------------------------------------------------------------------------------ regrade
export interface RegradeRow {
  episodeId: string;
  taskId: string;
  split: string;
  requestedModel: string | null;
  originalScore: number;
  score: number | null;
  originalGradedTreeDigest: string | null;
  gradedTreeDigest: string | null;
  match: boolean;
  error: string | null;
}

/** Deterministic re-grade of stored episodes (harness `--regrade`), tolerance 0. */
export async function regradeHarness(
  ctx: Ctx,
  h: HarnessInfo,
  a: { payloadDir: string; auditDir: string; episodes: EpisodeResult[]; venv: string; label: string },
): Promise<{ rows: RegradeRow[]; mismatches: number; exitCode: number | null; stderrTail: string }> {
  const scratch = harnessScratch(ctx, `regrade-${a.label}`);
  const input = path.join(scratch, 'episodes.jsonl');
  const graded = a.episodes.filter((e) => e.grade);
  fs.writeFileSync(
    input,
    graded
      .map((e) =>
        JSON.stringify({
          type: 'episode',
          episodeId: e.harnessEpisodeId ?? e.jobId,
          taskId: e.taskId,
          split: e.set,
          requestedModel: e.model,
          score: e.grade!.score,
          grade: { termination: e.grade!.termination, gradedTreeDigest: e.grade!.gradedTreeDigest },
          finalFiles: e.finalFiles,
        }),
      )
      .join('\n') + '\n',
  );
  const args = ['--regrade', input, '--bundle', a.payloadDir, '--audit-dir', a.auditDir, ...sandboxArgs(ctx.sandbox), '--venv', a.venv, '--work-dir', path.join(scratch, 'work')];
  try {
    const r = await runPy(h, args, harnessEnv(ctx.cfg), (graded.length * 300 + 600) * 1000);
    const rows = r.lines.filter((l) => l.type === 'regrade') as unknown as RegradeRow[];
    const summary = r.lines.find((l) => l.type === 'regrade_summary');
    // episodes the harness did not report count as mismatches (cannot be reproduced)
    const missing = graded.length - rows.length;
    return { rows, mismatches: Number(summary?.mismatches ?? rows.filter((x) => !x.match).length) + Math.max(0, missing), exitCode: r.code, stderrTail: r.stderr.slice(-2000) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Real LLM agent harness (pass@1): one episode per (model, task).
 *
 * Phase A — agent (sandboxed, offline): the seller grader's JSON-lines server
 *   `python -m grader.env serve` runs over a kit that contains src/, grader/ and ONLY this task's
 *   statement / overlay / visible tests (no hidden tests, no solutions, no other tasks). The model
 *   acts through OpenAI-style function calling: list_files, read_file, write_file,
 *   run_visible_tests, submit. Temperature 0, fixed seed, action budget 12 (submit is free),
 *   wall-clock time budget. Hidden tests are never in the agent's reach.
 * Phase B — grade (sandboxed, offline, separate process/uid): `python -m grader.grade` with this
 *   task's hidden tests against the final workspace. success = all hidden tests pass AND the
 *   episode ended by submission. Budget exhaustion / timeout / no submit = failure.
 * Infra failures (LLM API errors after retries, sandbox crashes) are recorded and count as
 * attempted-and-not-solved; they never leave the denominator.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, LlmError, sha256Hex, type ChatMessage, type ChatTool, type LlmClient } from '@envmarket/shared';
import type { Ctx } from './context.ts';
import { errMsg, logger } from './log.ts';
import { grantDir, nextUid, runSandboxed, scratchDir, spawnSandboxed } from './sandbox.ts';

export const HARNESS_ID = 'envmarket.harness.v1';

export const AGENT_SYSTEM_PROMPT = [
  'You are a software engineer repairing a bug in a small Python repository.',
  'You can only act through the provided tools: list_files, read_file, write_file, run_visible_tests and submit.',
  'write_file replaces the whole file, so always send the complete new file content.',
  'Each tool call except submit uses one action from a limited budget; when the budget is used up, only submit is accepted.',
  'The episode ends when you call submit and you cannot continue afterwards. A hidden test suite then grades your final workspace.',
  'Work efficiently: read the relevant code, make a minimal correct fix that keeps the public API unchanged, run the visible tests, then submit.',
].join(' ');

export const NUDGE = 'Continue by calling one of the tools. Call submit when your fix is complete.';

export const AGENT_TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace (or in a subdirectory).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: "workspace-relative directory, default '.'" } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a workspace file (first 64 KiB).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Replace the full content of an editable workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string', description: 'complete new file content' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: { name: 'run_visible_tests', description: 'Run the visible test suite and return its output.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  },
  {
    type: 'function',
    function: { name: 'submit', description: 'End the episode and submit the workspace for grading.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  },
];

export const TOOL_RESULT_MAX_CHARS = 12_000;
export const MAX_IDLE_TURNS = 3;
export const EXTRA_LLM_CALLS = 6; // model calls allowed beyond the action budget (submit, recoveries)

export function renderTaskMessage(obs: Record<string, any>): string {
  return [
    `Task: ${obs.title}`,
    '',
    String(obs.statement ?? ''),
    '',
    'Workspace files:',
    ...((obs.files as string[]) ?? []).map((f) => `- ${f}`),
    '',
    `Editable files (glob patterns): ${(obs.editable ?? []).join(', ')}`,
    `Visible test command: ${obs.visibleTestCmd}`,
    `Budget: ${obs.actionBudget} tool actions (submit is free); ${Math.round(Number(obs.timeBudgetSec))} seconds wall clock.`,
  ].join('\n');
}

/** promptDigest: sha256 of the canonical JSON of everything the model is shown besides task data. */
export function promptDigest(): `0x${string}` {
  return sha256Hex(canonicalJson({ system: AGENT_SYSTEM_PROMPT, nudge: NUDGE, tools: AGENT_TOOLS as unknown as object, userTemplate: renderTaskMessage.toString() }));
}

const HARNESS_SOURCE = fileURLToPath(import.meta.url);
/** harnessDigest: sha256 of the canonical harness spec + this file's source. */
export function harnessDigest(spec: Record<string, unknown>): `0x${string}` {
  return sha256Hex(canonicalJson({ id: HARNESS_ID, spec, source: sha256Hex(fs.readFileSync(HARNESS_SOURCE)) }));
}

// ------------------------------------------------------------------------------------------
/** JSON-lines client for `python -m grader.env serve`. */
class EnvSession {
  #next = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #buf = '';
  #dead: string | null = null;
  stderr = '';
  constructor(private readonly handle: ReturnType<typeof spawnSandboxed>) {
    const child = handle.child;
    child.stdout!.on('data', (d: Buffer) => {
      this.#buf += d.toString();
      let i: number;
      while ((i = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, i).trim();
        this.#buf = this.#buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          const p = msg.id !== undefined ? this.#pending.get(msg.id) : undefined;
          if (p) {
            this.#pending.delete(msg.id!);
            p.resolve(msg);
          }
        } catch {
          /* ignore non-JSON noise */
        }
      }
    });
    child.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    const fail = (why: string) => {
      this.#dead = why;
      for (const p of this.#pending.values()) p.reject(new Error(`env server ended: ${why}; stderr: ${this.stderr.slice(-500)}`));
      this.#pending.clear();
    };
    child.on('close', (code) => fail(`exit ${code}`));
    child.on('error', (e) => fail(errMsg(e)));
  }
  call(req: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    if (this.#dead) return Promise.reject(new Error(`env server not running (${this.#dead})`));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`env ${String(req.cmd)} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.handle.child.stdin!.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }
  close(): void {
    try {
      this.handle.child.stdin!.end();
    } catch {
      /* ignore */
    }
    this.handle.kill();
  }
}

// ------------------------------------------------------------------------------------------
export interface EpisodeSpec {
  jobId: string;
  requested: string;
  model: string;
  provider: string;
  taskId: string;
  set: 'purchased' | 'audit';
  seed: number;
  temperature: number;
  maxTokens: number;
  actionBudget: number;
  timeBudgetSec: number;
}

export interface EpisodeInputs {
  venv: string;
  payloadDir: string; // extracted purchased bundle
  taskSourceDir: string; // dir containing <taskId>/ (payload/tasks or audit dir)
}

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
  usage: { promptTokens: number; completionTokens: number };
  seedSent: boolean;
  startedAt: string;
  finishedAt: string;
  error: string | null;
  /** final contents of edited, editable files (for deterministic re-grading) */
  finalFiles: Record<string, string>;
  transcriptHash: `0x${string}`;
}

function copyTaskForAgent(src: string, dst: string): void {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p).split(path.sep);
      return !(rel[0] === 'tests' || rel[0] === 'solution' || rel.includes('__pycache__'));
    },
  });
}

function buildKit(root: string, payloadDir: string, taskSourceDir: string, taskId: string, withHidden: boolean): { kit: string; taskRoot: string } {
  const kit = path.join(root, withHidden ? 'gradekit' : 'kit');
  fs.mkdirSync(kit, { recursive: true });
  fs.cpSync(path.join(payloadDir, 'src'), path.join(kit, 'src'), { recursive: true });
  fs.cpSync(path.join(payloadDir, 'grader'), path.join(kit, 'grader'), { recursive: true, filter: (p) => !p.includes('__pycache__') });
  const taskRoot = path.join(kit, 'tasks');
  fs.mkdirSync(taskRoot, { recursive: true });
  const src = path.join(taskSourceDir, taskId);
  if (withHidden) fs.cpSync(src, path.join(taskRoot, taskId), { recursive: true, filter: (p) => path.basename(p) !== 'solution' || !fs.statSync(p).isDirectory() });
  else copyTaskForAgent(src, path.join(taskRoot, taskId));
  return { kit, taskRoot };
}

async function chat(client: LlmClient, spec: EpisodeSpec, messages: ChatMessage[], seed: number | undefined, timeoutMs: number) {
  return client.chat({
    model: spec.model,
    messages,
    tools: AGENT_TOOLS,
    toolChoice: 'auto',
    temperature: spec.temperature,
    seed,
    maxTokens: spec.maxTokens,
    timeoutMs,
  });
}

/** Grade a workspace dir with the task's hidden tests in a fresh sandboxed process. */
export async function gradeWorkspace(
  ctx: Ctx,
  inputs: EpisodeInputs,
  taskId: string,
  workspaceDir: string,
  termination: string,
  scratch: string,
): Promise<{ summary: GradeSummary | null; diagnostics: Record<string, unknown> | null; error: string | null }> {
  const { kit, taskRoot } = buildKit(scratch, inputs.payloadDir, inputs.taskSourceDir, taskId, true);
  const uid = nextUid(ctx.sandbox);
  const tmp = path.join(scratch, 'gtmp');
  fs.mkdirSync(tmp, { recursive: true });
  grantDir(ctx.sandbox, kit, uid, false);
  grantDir(ctx.sandbox, workspaceDir, uid, false);
  grantDir(ctx.sandbox, tmp, uid, true);
  const res = await runSandboxed(ctx.sandbox, {
    args: ['-m', 'grader.grade', '--task', taskId, '--workspace', workspaceDir, '--termination', termination, '--task-root', taskRoot],
    cwd: kit,
    readDirs: [kit, workspaceDir],
    writeDirs: [tmp],
    env: ctx.sandbox.kind === 'linux-root' ? { TMPDIR: tmp, HOME: tmp } : {},
    timeoutSec: 240,
    venv: inputs.venv,
    uid,
    label: `grade-${taskId}`,
  });
  const line = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    const g = JSON.parse(line) as Record<string, any>;
    if (g.ok === false) return { summary: null, diagnostics: null, error: `grader error: ${g.error?.message ?? 'unknown'}` };
    const d = (g.diagnostics ?? {}) as Record<string, any>;
    return {
      summary: {
        score: Number(g.score),
        success: !!g.success,
        termination: String(g.termination),
        passed: Number(g.passed),
        failed: Number(g.failed),
        collected: typeof d.collected === 'number' ? d.collected : null,
        allHiddenTestsPassed: !!d.allHiddenTestsPassed,
        timedOut: !!d.timedOut,
        editedFiles: Array.isArray(d.editedFiles) ? d.editedFiles : [],
        gradedTreeDigest: d.gradedTreeDigest ?? null,
      },
      diagnostics: d,
      error: null,
    };
  } catch {
    return { summary: null, diagnostics: null, error: `grader produced no result (exit ${res.code}${res.timedOut ? ', timed out' : ''}): ${res.stderr.slice(-400)}` };
  }
}

export async function runEpisode(ctx: Ctx, client: LlmClient, spec: EpisodeSpec, inputs: EpisodeInputs): Promise<EpisodeResult> {
  const startedAt = new Date().toISOString();
  const scratch = scratchDir(ctx.workRoot, `ep-${spec.jobId}`);
  const result: EpisodeResult = {
    jobId: spec.jobId,
    requested: spec.requested,
    model: spec.model,
    provider: spec.provider,
    taskId: spec.taskId,
    set: spec.set,
    status: 'failed',
    solved: false,
    termination: null,
    grade: null,
    actions: [],
    llmCalls: 0,
    servedModels: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    seedSent: true,
    startedAt,
    finishedAt: startedAt,
    error: null,
    finalFiles: {},
    transcriptHash: sha256Hex(''),
  };
  const messages: ChatMessage[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
  let session: EnvSession | null = null;
  const epDir = path.join(scratch, 'ep');
  const workdir = path.join(epDir, 'w');
  try {
    // ---------------------------------------------------------------- phase A: agent
    const { kit, taskRoot } = buildKit(scratch, inputs.payloadDir, inputs.taskSourceDir, spec.taskId, false);
    fs.mkdirSync(epDir, { recursive: true });
    const uid = nextUid(ctx.sandbox);
    grantDir(ctx.sandbox, kit, uid, false);
    grantDir(ctx.sandbox, epDir, uid, true);
    const handle = spawnSandboxed(ctx.sandbox, {
      args: ['-m', 'grader.env', 'serve', '--task-root', taskRoot],
      cwd: kit,
      readDirs: [kit],
      writeDirs: [epDir],
      env: ctx.sandbox.kind === 'linux-root' ? { TMPDIR: epDir, HOME: epDir } : {},
      timeoutSec: spec.timeBudgetSec + 120,
      venv: inputs.venv,
      uid,
      label: `agent-${spec.jobId}`,
    });
    session = new EnvSession(handle);
    const reset = await session.call({ cmd: 'reset', taskId: spec.taskId, seed: spec.seed, workdir, actionBudget: spec.actionBudget, timeBudgetSec: spec.timeBudgetSec }, 180_000);
    if (!reset.ok) throw new Error(`env reset failed: ${reset.error?.message ?? JSON.stringify(reset.error)}`);
    messages.push({ role: 'user', content: renderTaskMessage(reset.observation) });

    const deadline = Date.now() + spec.timeBudgetSec * 1000;
    const maxCalls = spec.actionBudget + EXTRA_LLM_CALLS;
    let done = false;
    let idle = 0;
    let seed: number | undefined = spec.seed;
    while (!done && result.llmCalls < maxCalls && Date.now() < deadline) {
      const remaining = Math.max(10_000, deadline - Date.now());
      let r;
      try {
        r = await chat(client, spec, messages, seed, Math.min(240_000, remaining + 30_000));
      } catch (e) {
        if (seed !== undefined && e instanceof LlmError && e.status === 400 && /seed/i.test(JSON.stringify(e.body ?? e.message))) {
          seed = undefined; // provider rejects `seed`: recorded as seedSent=false
          result.seedSent = false;
          r = await chat(client, spec, messages, undefined, Math.min(240_000, remaining + 30_000));
        } else throw e;
      }
      result.llmCalls++;
      if (!result.servedModels.includes(r.model)) result.servedModels.push(r.model);
      result.usage.promptTokens += r.usage.promptTokens ?? 0;
      result.usage.completionTokens += r.usage.completionTokens ?? 0;
      messages.push(r.message);
      if (r.toolCalls.length === 0) {
        if (++idle >= MAX_IDLE_TURNS) break;
        messages.push({ role: 'user', content: NUDGE });
        continue;
      }
      idle = 0;
      for (const tc of r.toolCalls) {
        if (done) {
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ ok: false, error: 'the episode has ended' }) });
          continue;
        }
        let args: Record<string, unknown> = {};
        let badArgs: string | null = null;
        try {
          const parsed = tc.function.arguments?.trim() ? JSON.parse(tc.function.arguments) : {};
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch (e) {
          badArgs = errMsg(e);
        }
        const action: Record<string, unknown> = { type: tc.function.name };
        if (typeof args.path === 'string') action.path = args.path;
        if (typeof args.content === 'string') action.content = args.content;
        if (badArgs) action.path = action.path ?? ' invalid-arguments'; // env rejects it (counts as an action)
        const resp = await session.call({ cmd: 'step', workdir, action }, 180_000);
        let content: string;
        if (!resp.ok) {
          content = JSON.stringify({ ok: false, error: resp.error?.message ?? 'error' });
          if (resp.error?.code === 'episode_done') done = true;
          result.actions.push({ type: tc.function.name, ok: false });
        } else {
          done = !!resp.done;
          result.termination = resp.termination ?? null;
          const obs = { ...resp.observation, actionsRemaining: resp.actionsRemaining, done: resp.done, termination: resp.termination };
          if (badArgs) obs.error = `invalid JSON arguments: ${badArgs}`;
          content = JSON.stringify(obs);
          result.actions.push({ type: tc.function.name, ...(typeof action.path === 'string' && !badArgs ? { path: action.path } : {}), ok: !!resp.observation?.ok });
        }
        if (content.length > TOOL_RESULT_MAX_CHARS) content = content.slice(0, TOOL_RESULT_MAX_CHARS) + '…[truncated]';
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content });
      }
    }
    session.close();
    session = null;

    // ---------------------------------------------------------------- phase B: grade
    const termination = result.termination ?? 'incomplete';
    const g = await gradeWorkspace(ctx, inputs, spec.taskId, path.join(workdir, 'workspace'), termination, scratch);
    if (!g.summary) throw new Error(g.error ?? 'grading failed');
    result.grade = g.summary;
    result.solved = g.summary.success;
    result.status = g.summary.success ? 'succeeded' : 'failed';
    for (const rel of g.summary.editedFiles) {
      const p = path.join(workdir, 'workspace', rel);
      if (fs.existsSync(p)) result.finalFiles[rel] = fs.readFileSync(p, 'utf8');
    }
  } catch (e) {
    result.status = 'infra_failure';
    result.solved = false;
    result.error = errMsg(e).slice(0, 1000);
    logger.warn('episode infra failure', { jobId: spec.jobId, error: result.error });
  } finally {
    session?.close();
    result.finishedAt = new Date().toISOString();
    result.transcriptHash = sha256Hex(canonicalJson(messages as unknown as object[]));
    ctx.priv.put('episodes', spec.jobId.replace(/[^A-Za-z0-9._:-]/g, '_'), { spec, result, messages });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  logger.info('episode done', { jobId: spec.jobId, status: result.status, termination: result.termination, llmCalls: result.llmCalls });
  return result;
}

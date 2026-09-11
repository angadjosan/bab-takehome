/**
 * Minimal, provider-agnostic OpenAI-compatible chat-completions client (fetch only).
 *
 * Default provider is Fireworks AI (https://api.fireworks.ai/inference/v1, Bearer
 * FIREWORKS_API_KEY) per the founder decision; any OpenAI-compatible endpoint works via
 * LLM_BASE_URL / LLM_API_KEY (e.g. Ollama at http://localhost:11434/v1 for local dev).
 * Every result records the exact `model` the server reports it served, the generation id,
 * and token usage (plus cost when the provider reports one).
 *
 * Env (role-specific first, then global):
 *   LLM_BASE_URL_<ROLE> | LLM_BASE_URL                   (default Fireworks)
 *   LLM_API_KEY_<ROLE>  | LLM_API_KEY | FIREWORKS_API_KEY (the latter only for Fireworks URLs)
 *   LLM_MODEL_<ROLE>    | LLM_MODEL
 *   LLM_TEMPERATURE[_<ROLE>], LLM_SEED[_<ROLE>], LLM_MAX_TOKENS[_<ROLE>], LLM_TIMEOUT_MS[_<ROLE>]
 * <ROLE> is the role upper-cased with non-alphanumerics → "_" (e.g. "validator" → VALIDATOR, "juror1" → JUROR1).
 */
import { z } from 'zod';

export const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_LLM_BASE_URL = FIREWORKS_BASE_URL;

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string; name?: string }
  | { role: 'user'; content: string; name?: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

export interface LlmConfig {
  baseURL: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Retries after the first attempt for network errors / 408 / 409 / 429 / 5xx (default 2). */
  retries?: number;
  headers?: Record<string, string>;
  /** Injected fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  tools?: ChatTool[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  stop?: string[];
  /** Extra provider-specific body fields. */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Provider-reported cost, if the provider reports one (Fireworks does not; null then). */
  cost: number | null;
  raw: unknown;
}

export interface ChatResult {
  /** Exact model id the server reports it served (falls back to the requested id). */
  model: string;
  requestedModel: string;
  /** Upstream provider if the server reports one, else null. */
  provider: string | null;
  /** Server generation id. */
  id: string | null;
  content: string | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  usage: LlmUsage;
  /** The assistant message, ready to append to a conversation. */
  message: Extract<ChatMessage, { role: 'assistant' }>;
  latencyMs: number;
  attempts: number;
  raw: unknown;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function isFireworks(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.endsWith('fireworks.ai');
  } catch {
    return false;
  }
}

function roleSuffix(role: string): string {
  return role.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function numEnv(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

/** Build an LlmConfig from env vars (see module doc). */
export function llmConfigFromEnv(role?: string, env: Record<string, string | undefined> = process.env): LlmConfig {
  const R = role ? roleSuffix(role) : null;
  const pick = (base: string) => (R ? env[`${base}_${R}`] || undefined : undefined) ?? (env[base] || undefined);
  const baseURL = pick('LLM_BASE_URL') ?? DEFAULT_LLM_BASE_URL;
  const apiKey = pick('LLM_API_KEY') ?? (isFireworks(baseURL) ? env.FIREWORKS_API_KEY || undefined : undefined);
  return {
    baseURL,
    apiKey,
    model: pick('LLM_MODEL'),
    temperature: numEnv(pick('LLM_TEMPERATURE'), 'LLM_TEMPERATURE'),
    seed: numEnv(pick('LLM_SEED'), 'LLM_SEED'),
    maxTokens: numEnv(pick('LLM_MAX_TOKENS'), 'LLM_MAX_TOKENS'),
    timeoutMs: numEnv(pick('LLM_TIMEOUT_MS'), 'LLM_TIMEOUT_MS'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

export class LlmClient {
  readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    if (!config.baseURL) throw new Error('LlmClient: baseURL required');
    this.config = { ...config, baseURL: config.baseURL.replace(/\/+$/, ''), headers: { ...(config.headers ?? {}) } };
  }

  static fromEnv(role?: string, env?: Record<string, string | undefined>): LlmClient {
    return new LlmClient(llmConfigFromEnv(role, env));
  }

  get model(): string | undefined {
    return this.config.model;
  }

  /** Same client, different default model / settings. */
  with(overrides: Partial<LlmConfig>): LlmClient {
    return new LlmClient({ ...this.config, ...overrides, headers: { ...this.config.headers, ...overrides.headers } });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...this.config.headers };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async request(
    pathname: string,
    init: { method: string; body?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ data: any; attempts: number }> {
    const f = this.config.fetch ?? fetch;
    const retries = this.config.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const timeout = AbortSignal.timeout(init.timeoutMs ?? this.config.timeoutMs ?? 180_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await f(this.config.baseURL + pathname, { method: init.method, headers: this.headers(), body: init.body, signal });
      } catch (e) {
        if (init.signal?.aborted) throw e;
        lastErr = new LlmError(`LLM request failed: ${(e as Error).message}`, null, null, true);
        if (attempt < retries) await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (!res.ok) {
        const msg =
          (data && typeof data === 'object' && (data.error?.message ?? data.message)) ||
          (typeof data === 'string' ? data.slice(0, 500) : res.statusText);
        lastErr = new LlmError(`LLM HTTP ${res.status}: ${msg}`, res.status, data, retryable);
        if (retryable && attempt < retries) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 500 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }
      if (data && typeof data === 'object' && data.error && !data.choices && !data.data) {
        const code = Number(data.error.code);
        const r = code === 429 || code >= 500;
        lastErr = new LlmError(`LLM error: ${data.error.message ?? JSON.stringify(data.error)}`, Number.isFinite(code) ? code : null, data, r);
        if (r && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }
      return { data, attempts: attempt + 1 };
    }
    throw lastErr;
  }

  /** One chat-completions call (non-streaming). */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? this.config.model;
    if (!model) throw new Error('LlmClient.chat: no model (set LLM_MODEL[_<ROLE>] or pass model)');
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? this.config.temperature,
      seed: req.seed ?? this.config.seed,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      tools: req.tools && req.tools.length > 0 ? req.tools : undefined,
      tool_choice: req.tools && req.tools.length > 0 ? req.toolChoice : undefined,
      response_format: req.responseFormat,
      stop: req.stop,
      stream: false,
      ...(req.extraBody ?? {}),
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

    const t0 = Date.now();
    const { data, attempts } = await this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    const choice = data?.choices?.[0];
    if (!choice) throw new LlmError('LLM response has no choices', null, data, false);
    if (choice.error) throw new LlmError(`LLM choice error: ${choice.error.message ?? JSON.stringify(choice.error)}`, null, data, false);
    const msg = choice.message ?? {};
    const toolCalls: ChatToolCall[] = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc: any, i: number) => ({
          id: String(tc.id ?? `call_${i}`),
          type: 'function' as const,
          function: {
            name: String(tc.function?.name ?? ''),
            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
          },
        }))
      : [];
    const content: string | null = typeof msg.content === 'string' ? msg.content : null;
    const u = data.usage ?? {};
    return {
      model: typeof data.model === 'string' && data.model ? data.model : model,
      requestedModel: model,
      provider: typeof data.provider === 'string' ? data.provider : null,
      id: typeof data.id === 'string' ? data.id : null,
      content,
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      usage: {
        promptTokens: num(u.prompt_tokens),
        completionTokens: num(u.completion_tokens),
        totalTokens: num(u.total_tokens),
        cost: num(u.cost),
        raw: data.usage ?? null,
      },
      message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      latencyMs: Date.now() - t0,
      attempts,
      raw: data,
    };
  }

  /** GET {baseURL}/models → raw model objects. */
  async listModels(): Promise<ProviderModel[]> {
    const { data } = await this.request('/models', { method: 'GET' });
    const arr = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(arr)) throw new LlmError('unexpected /models response', null, data, false);
    return arr as ProviderModel[];
  }
}

/** Model entry from GET /models (OpenAI shape; Fireworks adds supports_* flags). */
export interface ProviderModel {
  id: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  supports_chat?: boolean;
  supports_tools?: boolean;
  supported_parameters?: string[];
  [k: string]: unknown;
}

export interface ResolvedModel {
  family: string;
  id: string;
  created: number | null;
  /** Version parsed from the id (e.g. glm-4p6 → [4, 6]); used when `created` is absent. */
  version: number[];
  contextLength: number | null;
  raw: ProviderModel;
}

export interface PickModelsOptions {
  /** Exclude ids matching this (default: none). */
  exclude?: RegExp | null;
  /** Require tool-calling support (supports_tools === true or "tools" in supported_parameters). */
  requireTools?: boolean;
}

function modelPart(id: string): string {
  const i = id.toLowerCase();
  return i.slice(i.lastIndexOf('/') + 1);
}

/**
 * Family match: a bare word (e.g. "glm", "kimi", "qwen") matches ids whose last path segment
 * starts with it (so `accounts/fireworks/models/glm-4p6` is in "glm"); a value containing "/"
 * matches as an id prefix (e.g. "accounts/fireworks/models/qwen3").
 */
export function modelMatchesFamily(id: string, family: string): boolean {
  const f = family.toLowerCase();
  return f.includes('/') ? id.toLowerCase().startsWith(f) : modelPart(id).startsWith(f);
}

/**
 * Version parsed from an id, relative to its family: the first numeric group after the family
 * word, with "p" or "." as the decimal separator (glm-4p6 → [4,6], kimi-k2p5 → [2,5],
 * qwen3-235b → [3]), followed by a trailing 4-digit date-like token if present
 * (kimi-k2-instruct-0905 → [2, 0, 905]; missing parts are 0).
 */
export function parseModelVersion(id: string, family: string): number[] {
  const f = family.toLowerCase();
  const part = modelPart(id);
  const rest = f.includes('/') ? id.toLowerCase().slice(f.length) : part.slice(part.indexOf(f) + f.length);
  const m = /^[-_]?[a-z]?(\d+(?:[p.]\d+)*)/.exec(rest);
  const main = m ? m[1]!.split(/[p.]/).map(Number) : [];
  while (main.length < 2) main.push(0);
  const dates = [...part.matchAll(/(?:^|-)(\d{4})(?=$|-)/g)];
  const date = dates.length ? Number(dates[dates.length - 1]![1]) : 0;
  return [...main.slice(0, 4), ...Array(Math.max(0, 4 - main.length)).fill(0), date];
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Pure selection of the newest chat model per family: by `created` when both candidates have
 * one, else by the version parsed from the id, then by id. Entries with supports_chat === false
 * are skipped.
 */
export function pickNewestModels(models: ProviderModel[], families: string[], opts: PickModelsOptions = {}): Record<string, ResolvedModel | null> {
  const out: Record<string, ResolvedModel | null> = {};
  for (const family of families) {
    const candidates = models
      .filter(
        (m) =>
          typeof m.id === 'string' &&
          modelMatchesFamily(m.id, family) &&
          m.supports_chat !== false &&
          !(opts.exclude && opts.exclude.test(m.id)) &&
          (!opts.requireTools || m.supports_tools === true || (m.supported_parameters ?? []).includes('tools')),
      )
      .map((m) => ({ m, created: typeof m.created === 'number' && m.created > 0 ? m.created : null, version: parseModelVersion(m.id, family) }));
    candidates.sort((a, b) => {
      if (a.created !== null && b.created !== null && a.created !== b.created) return b.created - a.created;
      const v = cmpVersion(b.version, a.version);
      if (v !== 0) return v;
      return a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0;
    });
    const c = candidates[0];
    out[family] = c
      ? { family, id: c.m.id, created: c.created, version: c.version, contextLength: typeof c.m.context_length === 'number' ? c.m.context_length : null, raw: c.m }
      : null;
  }
  return out;
}

/**
 * List GET {baseURL}/models and pick the newest model id per family.
 * Uses the env-configured provider (Fireworks by default) unless a client is given.
 * Example: resolveModels(["glm", "kimi", "qwen"]).
 */
export async function resolveModels(
  families: string[],
  opts: PickModelsOptions & { client?: LlmClient } = {},
): Promise<Record<string, ResolvedModel | null>> {
  const client = opts.client ?? LlmClient.fromEnv();
  return pickNewestModels(await client.listModels(), families, opts);
}

/** Pull a JSON value out of model text: strips <think> blocks and code fences, then parses. */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    const starts = ['{', '['].map((c) => t.indexOf(c)).filter((i) => i >= 0);
    if (starts.length === 0) throw new Error('no JSON found in model output');
    const start = Math.min(...starts);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (end <= start) throw new Error('no JSON found in model output');
    return JSON.parse(t.slice(start, end + 1));
  }
}

export class LlmJsonError extends Error {
  constructor(
    message: string,
    readonly outputs: string[],
    readonly results: ChatResult[],
  ) {
    super(message);
    this.name = 'LlmJsonError';
  }
}

export interface JsonResponseOptions<T> extends Omit<ChatRequest, 'responseFormat' | 'tools' | 'toolChoice'> {
  schema: z.ZodType<T>;
  /** Schema name for json_schema mode. */
  name?: string;
  /** "json_object" (default), "json_schema" (structured outputs), or "none" (prompt only). */
  mode?: 'json_object' | 'json_schema' | 'none';
  /** Include the JSON Schema text in the system prompt (default true). */
  includeSchemaInPrompt?: boolean;
}

export interface JsonResponse<T> {
  value: T;
  result: ChatResult;
  results: ChatResult[];
  repaired: boolean;
}

function zodMessage(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return (e as Error).message;
}

/**
 * Ask for JSON output and validate it with zod; on failure, one repair retry that shows the
 * model its output and the validation error. Falls back to no response_format if the server
 * rejects the parameter.
 */
export async function jsonSchemaResponse<T>(client: LlmClient, opts: JsonResponseOptions<T>): Promise<JsonResponse<T>> {
  const { schema, name = 'response', mode = 'json_object', includeSchemaInPrompt = true, ...chatReq } = opts;
  let jsonSchema: Record<string, unknown> | null = null;
  try {
    jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  } catch {
    jsonSchema = null;
  }
  const instruction =
    'Respond with a single JSON value only: no prose, no markdown code fences.' +
    (includeSchemaInPrompt && jsonSchema ? `\nIt must conform to this JSON Schema:\n${JSON.stringify(jsonSchema)}` : '');
  const messages: ChatMessage[] = [...chatReq.messages];
  const firstSys = messages.findIndex((m) => m.role === 'system');
  if (firstSys >= 0) {
    const m = messages[firstSys] as { role: 'system'; content: string };
    messages[firstSys] = { role: 'system', content: `${m.content}\n\n${instruction}` };
  } else {
    messages.unshift({ role: 'system', content: instruction });
  }
  let responseFormat: ResponseFormat | undefined =
    mode === 'json_object'
      ? { type: 'json_object' }
      : mode === 'json_schema' && jsonSchema
        ? { type: 'json_schema', json_schema: { name, schema: jsonSchema, strict: true } }
        : undefined;

  const call = async (msgs: ChatMessage[]): Promise<ChatResult> => {
    try {
      return await client.chat({ ...chatReq, messages: msgs, responseFormat });
    } catch (e) {
      if (responseFormat && e instanceof LlmError && e.status === 400 && /response_format|json/i.test(JSON.stringify(e.body ?? e.message))) {
        responseFormat = undefined;
        return client.chat({ ...chatReq, messages: msgs });
      }
      throw e;
    }
  };

  const results: ChatResult[] = [];
  const outputs: string[] = [];
  const attemptParse = (r: ChatResult): { ok: true; value: T } | { ok: false; error: string } => {
    const text = r.content ?? '';
    outputs.push(text);
    try {
      return { ok: true, value: schema.parse(extractJson(text)) };
    } catch (e) {
      return { ok: false, error: zodMessage(e) };
    }
  };

  const first = await call(messages);
  results.push(first);
  const p1 = attemptParse(first);
  if (p1.ok) return { value: p1.value, result: first, results, repaired: false };

  const repairMsgs: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: first.content ?? '' },
    {
      role: 'user',
      content: `Your previous output was invalid: ${p1.error}\nReply again with only the corrected JSON, conforming exactly to the schema.`,
    },
  ];
  const second = await call(repairMsgs);
  results.push(second);
  const p2 = attemptParse(second);
  if (p2.ok) return { value: p2.value, result: second, results, repaired: true };
  throw new LlmJsonError(`model output failed validation after repair: ${p2.error}`, outputs, results);
}

export interface ToolHandler {
  tool: ChatTool;
  handler: (args: any) => Promise<string> | string;
}

export interface ToolLoopResult {
  final: ChatResult;
  messages: ChatMessage[];
  steps: ChatResult[];
  toolCallCount: number;
}

/**
 * Function-calling loop: call the model with tools, execute requested tools, feed results
 * back, until the model answers without tool calls or `maxSteps` model calls are used.
 * Tool errors and bad arguments are returned to the model as tool output, not thrown.
 */
export async function runToolLoop(
  client: LlmClient,
  opts: Omit<ChatRequest, 'tools'> & { tools: ToolHandler[]; maxSteps?: number },
): Promise<ToolLoopResult> {
  const { tools, maxSteps = 8, ...req } = opts;
  const byName = new Map(tools.map((t) => [t.tool.function.name, t]));
  const messages: ChatMessage[] = [...req.messages];
  const steps: ChatResult[] = [];
  let toolCallCount = 0;
  for (let step = 0; step < maxSteps; step++) {
    const r = await client.chat({ ...req, messages, tools: tools.map((t) => t.tool), toolChoice: req.toolChoice ?? 'auto' });
    steps.push(r);
    messages.push(r.message);
    if (r.toolCalls.length === 0) return { final: r, messages, steps, toolCallCount };
    for (const tc of r.toolCalls) {
      toolCallCount++;
      const h = byName.get(tc.function.name);
      let output: string;
      if (!h) output = `error: unknown tool ${tc.function.name}`;
      else {
        try {
          const args = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
          output = await h.handler(args);
        } catch (e) {
          output = `error: ${(e as Error).message}`;
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: output });
    }
  }
  const final = steps[steps.length - 1]!;
  return { final, messages, steps, toolCallCount };
}

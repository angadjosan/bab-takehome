/**
 * LLM client tests. Protocol behaviour (retries, tool calls, JSON repair) is exercised against a
 * local HTTP server speaking the OpenAI chat-completions wire format; a live Fireworks call runs
 * when FIREWORKS_API_KEY is set.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultModelForRole,
  extractJson,
  FIREWORKS_BASE_URL,
  jsonSchemaResponse,
  LlmClient,
  LlmJsonError,
  llmConfigFromEnv,
  loadEnv,
  MODELS,
  parseModelVersion,
  pickNewestModels,
  resolveModels,
  resolvePanel,
  runToolLoop,
} from '../src/index.ts';

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseURL = '';
const queue: Handler[] = [];
const seen: any[] = [];

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
const completion = (message: any, extra: any = {}) => ({
  id: 'gen-1',
  model: 'accounts/fireworks/models/served-model',
  choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...extra,
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const h = queue.shift();
      if (!h) return reply(res, 500, { error: { message: 'no handler queued' } });
      h(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

describe('llmConfigFromEnv', () => {
  it('defaults to Fireworks with FIREWORKS_API_KEY; role overrides win', () => {
    const c = llmConfigFromEnv('juror1', { FIREWORKS_API_KEY: 'fw', LLM_MODEL: 'm', LLM_MODEL_JUROR1: 'j', LLM_TEMPERATURE: '0.2' });
    expect(c.baseURL).toBe(FIREWORKS_BASE_URL);
    expect(c.apiKey).toBe('fw');
    expect(c.model).toBe('j');
    expect(c.temperature).toBe(0.2);
    const o = llmConfigFromEnv('validator', { LLM_BASE_URL: 'http://localhost:11434/v1', FIREWORKS_API_KEY: 'fw', LLM_MODEL: 'qwen3:8b' });
    expect(o.apiKey).toBe(undefined); // Fireworks key is not sent to other providers
    expect(o.model).toBe('qwen3:8b');
  });
});

describe('LlmClient', () => {
  it('sends OpenAI-format body with auth; records served model and usage', async () => {
    queue.push((body, _req, res) => reply(res, 200, completion({ role: 'assistant', content: 'hi' })));
    const c = new LlmClient({ baseURL, apiKey: 'k', model: 'req-model', temperature: 0, seed: 7, maxTokens: 64 });
    const r = await c.chat({ messages: [{ role: 'user', content: 'hello' }] });
    const s = seen[seen.length - 1];
    expect(s.url).toBe('/v1/chat/completions');
    expect(s.auth).toBe('Bearer k');
    expect(s.body).toMatchObject({ model: 'req-model', temperature: 0, seed: 7, max_tokens: 64, stream: false });
    expect(r.content).toBe('hi');
    expect(r.model).toBe('accounts/fireworks/models/served-model');
    expect(r.requestedModel).toBe('req-model');
    expect(r.usage.totalTokens).toBe(15);
    expect(r.id).toBe('gen-1');
  });

  it('retries 429/5xx then succeeds; does not retry 400', async () => {
    queue.push((_b, _q, res) => reply(res, 503, { error: { message: 'busy' } }));
    queue.push((_b, _q, res) => reply(res, 429, { error: { message: 'slow down' } }));
    queue.push((_b, _q, res) => reply(res, 200, completion({ role: 'assistant', content: 'ok' })));
    const c = new LlmClient({ baseURL, model: 'm', retries: 2 });
    const r = await c.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(r.content).toBe('ok');
    expect(r.attempts).toBe(3);
    queue.push((_b, _q, res) => reply(res, 400, { error: { message: 'bad' } }));
    await expect(c.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/HTTP 400: bad/);
  });

  it('times out', async () => {
    queue.push(() => {}); // never responds
    const c = new LlmClient({ baseURL, model: 'm', retries: 0, timeoutMs: 200 });
    await expect(c.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/failed/);
  });

  it('tool loop executes function calls and feeds results back', async () => {
    queue.push((body, _q, res) => {
      expect(body.tools[0].function.name).toBe('read_file');
      reply(res, 200, completion({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.py"}' } }] }));
    });
    queue.push((body, _q, res) => {
      const last = body.messages[body.messages.length - 1];
      expect(last).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'print(1)' });
      reply(res, 200, completion({ role: 'assistant', content: 'done' }));
    });
    const c = new LlmClient({ baseURL, model: 'm' });
    const out = await runToolLoop(c, {
      messages: [{ role: 'user', content: 'read a.py' }],
      tools: [
        {
          tool: { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
          handler: (args: { path: string }) => (args.path === 'a.py' ? 'print(1)' : 'missing'),
        },
      ],
    });
    expect(out.final.content).toBe('done');
    expect(out.toolCallCount).toBe(1);
  });
});

describe('jsonSchemaResponse', () => {
  const schema = z.object({ verdict: z.enum(['Uphold', 'Reject']), confidence: z.number().min(0).max(1) });

  it('parses valid JSON (with fences/think blocks) on first try and requests json_object', async () => {
    queue.push((body, _q, res) => {
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toContain('JSON Schema');
      reply(res, 200, completion({ role: 'assistant', content: '<think>hmm</think>```json\n{"verdict":"Uphold","confidence":0.8}\n```' }));
    });
    const r = await jsonSchemaResponse(new LlmClient({ baseURL, model: 'm' }), { schema, messages: [{ role: 'user', content: 'decide' }] });
    expect(r.value).toEqual({ verdict: 'Uphold', confidence: 0.8 });
    expect(r.repaired).toBe(false);
  });

  it('repairs once with the validation error', async () => {
    queue.push((_b, _q, res) => reply(res, 200, completion({ role: 'assistant', content: '{"verdict":"maybe","confidence":2}' })));
    queue.push((body, _q, res) => {
      const last = body.messages[body.messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.content).toMatch(/invalid: .*verdict/);
      reply(res, 200, completion({ role: 'assistant', content: '{"verdict":"Reject","confidence":0.4}' }));
    });
    const r = await jsonSchemaResponse(new LlmClient({ baseURL, model: 'm' }), { schema, messages: [{ role: 'system', content: 'You are a juror.' }, { role: 'user', content: 'decide' }] });
    expect(r.value.verdict).toBe('Reject');
    expect(r.repaired).toBe(true);
  });

  it('throws LlmJsonError after a failed repair; falls back when response_format is rejected', async () => {
    queue.push((_b, _q, res) => reply(res, 200, completion({ role: 'assistant', content: 'nope' })));
    queue.push((_b, _q, res) => reply(res, 200, completion({ role: 'assistant', content: 'still nope' })));
    await expect(jsonSchemaResponse(new LlmClient({ baseURL, model: 'm' }), { schema, messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(LlmJsonError);

    queue.push((_b, _q, res) => reply(res, 400, { error: { message: 'response_format not supported' } }));
    queue.push((body, _q, res) => {
      expect(body.response_format).toBeUndefined();
      reply(res, 200, completion({ role: 'assistant', content: '{"verdict":"Uphold","confidence":1}' }));
    });
    const r = await jsonSchemaResponse(new LlmClient({ baseURL, model: 'm' }), { schema, messages: [{ role: 'user', content: 'x' }] });
    expect(r.value.confidence).toBe(1);
  });

  it('extractJson', () => {
    expect(extractJson('Sure! {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
    expect(() => extractJson('no json')).toThrow();
  });
});

describe('model resolution', () => {
  const P = 'accounts/fireworks/models/';
  const models = [
    { id: P + 'glm-4p5', supports_chat: true },
    { id: P + 'glm-4p6', supports_chat: true, supports_tools: true },
    { id: P + 'glm-4p5-air', supports_chat: true },
    { id: P + 'kimi-k2-instruct', supports_chat: true },
    { id: P + 'kimi-k2-instruct-0905', supports_chat: true, supports_tools: true },
    { id: P + 'qwen2p5-72b-instruct', supports_chat: true },
    { id: P + 'qwen3-235b-a22b-instruct-2507', supports_chat: true, supports_tools: true },
    { id: P + 'qwen3-coder-480b-a35b-instruct', supports_chat: true },
    { id: P + 'qwen3-embedding-8b', supports_chat: false },
    { id: P + 'deepseek-v3p1', supports_chat: true },
  ];

  it('parses versions from Fireworks ids', () => {
    expect(parseModelVersion(P + 'glm-4p6', 'glm').slice(0, 2)).toEqual([4, 6]);
    expect(parseModelVersion(P + 'kimi-k2-instruct-0905', 'kimi')).toEqual([2, 0, 0, 0, 905]);
    expect(parseModelVersion(P + 'qwen2p5-72b-instruct', 'qwen').slice(0, 2)).toEqual([2, 5]);
    // ids pinned in BUILD_SPEC (verified on Fireworks 2026-09-10)
    expect(parseModelVersion(P + 'glm-5p3', 'glm').slice(0, 2)).toEqual([5, 3]);
    expect(parseModelVersion(P + 'kimi-k3', 'kimi').slice(0, 2)).toEqual([3, 0]);
    expect(parseModelVersion(P + 'qwen3p8-max', 'qwen').slice(0, 2)).toEqual([3, 8]);
    expect(parseModelVersion(P + 'deepseek-v4p1-flash', 'deepseek').slice(0, 2)).toEqual([4, 1]);
  });

  it('pinned panel ids win over older family members', () => {
    const list = ['glm-5p3', 'glm-5p2', 'glm-4p6', 'kimi-k3', 'kimi-k2-instruct-0905', 'qwen3p8-max', 'qwen3-235b-a22b-instruct-2507'].map((id) => ({ id: P + id }));
    const r = pickNewestModels(list, ['glm', 'kimi', 'qwen']);
    expect([r.glm!.id, r.kimi!.id, r.qwen!.id]).toEqual([P + 'glm-5p3', P + 'kimi-k3', P + 'qwen3p8-max']);
  });

  it('picks the newest per family by version when created is absent', () => {
    const r = pickNewestModels(models, ['glm', 'kimi', 'qwen', 'deepseek', 'mistral']);
    expect(r.glm!.id).toBe(P + 'glm-4p6');
    expect(r.kimi!.id).toBe(P + 'kimi-k2-instruct-0905');
    expect(r.qwen!.id).toBe(P + 'qwen3-235b-a22b-instruct-2507');
    expect(r.deepseek!.id).toBe(P + 'deepseek-v3p1');
    expect(r.mistral).toBe(null);
  });

  it('prefers created when present; requireTools filter', () => {
    const withCreated = [
      { id: P + 'glm-5', created: 100 },
      { id: P + 'glm-4p6', created: 200 },
    ];
    expect(pickNewestModels(withCreated, ['glm']).glm!.id).toBe(P + 'glm-4p6');
    expect(pickNewestModels(models, ['qwen'], { requireTools: true }).qwen!.id).toBe(P + 'qwen3-235b-a22b-instruct-2507');
  });

  it('resolveModels lists GET /models', async () => {
    queue.push((_b, req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/v1/models');
      reply(res, 200, { object: 'list', data: models });
    });
    const r = await resolveModels(['glm'], { client: new LlmClient({ baseURL }) });
    expect(r.glm!.id).toBe(P + 'glm-4p6');
  });
});

describe('pinned models', () => {
  it('role defaults: LLM_MODEL_<ROLE> > pinned (Fireworks) > LLM_MODEL', () => {
    expect(defaultModelForRole('validator')).toBe(MODELS.validator);
    expect(defaultModelForRole('juror2')).toBe('accounts/fireworks/models/gpt-oss-120b');
    expect(defaultModelForRole('panel-qwen')).toBe('accounts/fireworks/models/qwen3p8-max');
    expect(defaultModelForRole('seller')).toBe(undefined);
    expect(llmConfigFromEnv('validator', { LLM_MODEL: 'generic' }).model).toBe(MODELS.validator);
    expect(llmConfigFromEnv('juror3', { LLM_MODEL_JUROR3: 'override' }).model).toBe('override');
    expect(llmConfigFromEnv('seller', { LLM_MODEL: 'generic' }).model).toBe('generic');
    expect(llmConfigFromEnv('validator', { LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: 'qwen3:8b' }).model).toBe('qwen3:8b');
  });

  it('resolver skips router endpoints by default', () => {
    const list = [
      { id: 'accounts/fireworks/models/glm-5p3', created: 100 },
      { id: 'accounts/fireworks/routers/glm-5p3-fast', created: 200 },
    ];
    expect(pickNewestModels(list, ['glm']).glm!.id).toBe('accounts/fireworks/models/glm-5p3');
    expect(pickNewestModels(list, ['glm'], { exclude: null }).glm!.id).toBe('accounts/fireworks/routers/glm-5p3-fast');
  });

  it('resolvePanel uses pinned ids when listed and falls back per family otherwise', async () => {
    queue.push((_b, _q, res) =>
      reply(res, 200, {
        data: [
          { id: 'accounts/fireworks/models/glm-5p3', created: 1 },
          { id: 'accounts/fireworks/models/kimi-k2p6', created: 2 },
        ],
      }),
    );
    const p = await resolvePanel({ client: new LlmClient({ baseURL }) });
    expect(p.map((x) => [x.family, x.id.split('/').pop(), x.pinned, x.listed])).toEqual([
      ['glm', 'glm-5p3', true, true],
      ['kimi', 'kimi-k2p6', false, true],
      ['qwen', 'qwen3p8-max', true, false],
    ]);
  });
});

// Live smoke test against real Fireworks inference, using FIREWORKS_API_KEY from the repo .env
// (read without mutating process.env).
const FW_KEY = (() => {
  try {
    return loadEnv({ populateProcessEnv: false }).env.FIREWORKS_API_KEY;
  } catch {
    return process.env.FIREWORKS_API_KEY;
  }
})();

describe.skipIf(!FW_KEY)('live Fireworks', () => {
  const client = new LlmClient({ baseURL: FIREWORKS_BASE_URL, apiKey: FW_KEY, retries: 2, timeoutMs: 120_000 });

  it('all pinned panel/validator/juror ids are listed by GET /models', async () => {
    const panel = await resolvePanel({ client });
    expect(panel.every((p) => p.pinned && p.listed)).toBe(true);
    const ids = new Set((await client.listModels()).map((m) => m.id));
    for (const id of [MODELS.validator, ...Object.values(MODELS.jurors)]) expect(ids.has(id)).toBe(true);
    const newest = await resolveModels(['glm', 'kimi', 'qwen'], { client });
    console.log('[live] resolver newest per family:', Object.values(newest).map((m) => m?.id).join(', '));
  }, 60_000);

  // Listing is not serving: GET /models listed `deepseek-v4-pro` while chat 404'd "not deployed".
  it('every pinned model serves a real 1-token chat completion', async () => {
    const ids = [...MODELS.panel.map((p) => p.id), MODELS.validator, ...Object.values(MODELS.jurors)];
    const settled = await Promise.allSettled(
      ids.map((model) => client.chat({ model, maxTokens: 1, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] })),
    );
    const failed = settled.flatMap((s, i) => (s.status === 'rejected' ? [`${ids[i]}: ${(s.reason as Error).message}`] : []));
    console.log('[live] pinned models served:', settled.map((s, i) => `${ids[i]!.split('/').pop()}=${s.status === 'fulfilled' ? s.value.model.split('/').pop() : 'FAIL'}`).join(', '));
    expect(failed).toEqual([]);
    for (const s of settled) if (s.status === 'fulfilled') expect(s.value.usage.promptTokens ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('real tool call round trip (one function call, then the answer)', async () => {
    let calls = 0;
    const out = await runToolLoop(client, {
      model: MODELS.jurors.juror1,
      temperature: 0,
      maxTokens: 512,
      messages: [
        { role: 'system', content: 'You answer questions about a software bundle. Use the provided tool; do not guess.' },
        { role: 'user', content: 'How many purchased tasks does the bundle contain? Call the tool, then reply with just the number.' },
      ],
      tools: [
        {
          tool: {
            type: 'function',
            function: {
              name: 'get_task_count',
              description: 'Returns the number of purchased tasks in the bundle.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
          handler: () => {
            calls++;
            return JSON.stringify({ taskCount: 7 });
          },
        },
      ],
      maxSteps: 4,
    });
    console.log('[live] tool loop:', { model: out.final.model, steps: out.steps.length, toolCalls: out.toolCallCount, answer: out.final.content, usage: out.steps.map((s) => s.usage.totalTokens) });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(out.final.content ?? '').toContain('7');
    expect(out.final.model).toContain('deepseek');
  }, 180_000);

  it('real JSON response validated with zod', async () => {
    const schema = z.object({ verdict: z.enum(['Uphold', 'Reject']), reason: z.string().max(200) });
    const r = await jsonSchemaResponse(client, {
      model: MODELS.jurors.juror1,
      temperature: 0,
      maxTokens: 512,
      schema,
      messages: [
        { role: 'system', content: 'You are a juror. The claim is "the bundle has 5 tasks"; evidence shows it has 3 tasks.' },
        { role: 'user', content: 'Is the buyer\'s false-description claim upheld? Give verdict and a one-sentence reason.' },
      ],
    });
    console.log('[live] json:', { model: r.result.model, repaired: r.repaired, value: r.value, usage: r.result.usage.totalTokens });
    expect(r.value.verdict).toBe('Uphold');
  }, 180_000);
});

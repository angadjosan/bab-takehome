/**
 * One juror decision: fixed rubric prompt + case packet -> strict JSON verdict -> screened public
 * rationale. Up to MAX_ATTEMPTS model calls; a malformed reply gets a corrective follow-up.
 */
import type { ChatMessage, ChatResult, LlmClient } from '@envmarket/shared';
import type { Hex } from 'viem';
import { parseJurorOutput, privateCorpus, renderUserPrompt, screenDecision, shingles, type JurorOutput, type Rubric } from './rubric.ts';
import type { Decision } from './state.ts';

export const MAX_ATTEMPTS = 3;

export interface DecideInput {
  rubric: Rubric;
  llm: { client: Pick<LlmClient, 'chat'>; kind: string; baseUrl: string; requested: string; model: string };
  chainFacts: Record<string, unknown>;
  packet: unknown;
  packetText: string;
  packetSha256: Hex;
  log?: (line: string) => void;
}

async function chatJson(client: Pick<LlmClient, 'chat'>, messages: ChatMessage[]): Promise<ChatResult> {
  try {
    return await client.chat({ messages, responseFormat: { type: 'json_object' } });
  } catch (e) {
    const status = (e as { status?: number }).status;
    const msg = JSON.stringify((e as { body?: unknown }).body ?? (e as Error).message);
    if (status === 400 && /response_format|json/i.test(msg)) return client.chat({ messages });
    throw e;
  }
}

export async function decide(input: DecideInput): Promise<Decision> {
  const { rubric, llm } = input;
  const messages: ChatMessage[] = [
    { role: 'system', content: rubric.system },
    { role: 'user', content: renderUserPrompt(rubric, input.chainFacts, input.packetText) },
  ];
  let lastErrors: string[] = [];
  let partial: Partial<JurorOutput> | undefined;
  let served = llm.model;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await chatJson(llm.client, messages);
    served = r.model;
    const text = r.content ?? '';
    const parsed = parseJurorOutput(text);
    if (parsed.ok) {
      return finish(input, parsed.value, served, attempt);
    }
    lastErrors = parsed.errors;
    if (parsed.partial?.verdict) partial = parsed.partial;
    input.log?.(`model reply invalid (attempt ${attempt}/${MAX_ATTEMPTS}): ${parsed.errors.join('; ')}`);
    messages.push(
      { role: 'assistant', content: text.slice(0, 4000) },
      {
        role: 'user',
        content: `Your reply was invalid: ${parsed.errors.join('; ')}. Reply again with only the JSON object {"verdict","confidence","rationale","citedFacts"} following every rule (rationale at most 80 words, 1 to 5 citedFacts of at most 25 words).`,
      },
    );
  }
  // Only word limits failed but a verdict is clear: keep the verdict; screening withholds prose.
  if (partial?.verdict && typeof partial.confidence === 'number' && typeof partial.rationale === 'string' && Array.isArray(partial.citedFacts)) {
    input.log?.('using verdict from a reply that only violated length limits; public text will be screened');
    return finish(input, partial as JurorOutput, served, MAX_ATTEMPTS);
  }
  throw new Error(`no valid juror output after ${MAX_ATTEMPTS} attempts: ${lastErrors.join('; ')}`);
}

function finish(input: DecideInput, output: JurorOutput, served: string, attempts: number): Decision {
  const pub = screenDecision(output, shingles(privateCorpus(input.packet)));
  return {
    output,
    public: pub,
    model: { provider: input.llm.kind, baseUrl: input.llm.baseUrl, requested: input.llm.requested, resolved: input.llm.model, served },
    promptVersion: input.rubric.version,
    promptHash: input.rubric.hash,
    packetSha256: input.packetSha256,
    attempts,
    decidedAt: new Date().toISOString(),
  };
}

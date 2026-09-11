/**
 * Fixed juror rubric: prompt loading/hashing/rendering, strict output parsing, and screening of
 * the public rationale. Evidence is untrusted data; nothing here executes or follows it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const PROMPT_VERSION = 'juror-v1';
export const PROMPT_PATH = fileURLToPath(new URL(`../prompts/${PROMPT_VERSION}.md`, import.meta.url));
export const RATIONALE_MAX_WORDS = 80;
export const RATIONALE_MAX_BYTES = 700;
export const FACT_MAX_WORDS = 25;
export const MAX_FACTS = 5;
export const WITHHELD_RATIONALE = 'Rationale withheld by output screening.';
/** Case packets larger than this are truncated before prompting (the hash covers the full packet). */
export const MAX_PACKET_CHARS = 60_000;

export interface Rubric {
  version: string;
  /** sha256 of the exact prompt file bytes, 0x-prefixed. */
  hash: `0x${string}`;
  system: string;
  userTemplate: string;
}

export function sha256Hex(data: string | Uint8Array): `0x${string}` {
  return `0x${createHash('sha256').update(data).digest('hex')}`;
}

export function parseRubric(text: string, version = PROMPT_VERSION): Rubric {
  const s = text.indexOf('<<<SYSTEM>>>');
  const u = text.indexOf('<<<USER>>>');
  if (s < 0 || u < 0 || u < s) throw new Error('prompt file must contain <<<SYSTEM>>> then <<<USER>>>');
  const system = text.slice(s + '<<<SYSTEM>>>'.length, u).trim();
  const userTemplate = text.slice(u + '<<<USER>>>'.length).trim();
  if (!userTemplate.includes('{{CASE_PACKET}}') || !userTemplate.includes('{{CHAIN_FACTS}}')) {
    throw new Error('user template must contain {{CASE_PACKET}} and {{CHAIN_FACTS}}');
  }
  return { version, hash: sha256Hex(text), system, userTemplate };
}

export function loadRubric(path = PROMPT_PATH): Rubric {
  return parseRubric(readFileSync(path, 'utf8'));
}

/**
 * Neutralize anything in untrusted evidence that could close our delimiter or impersonate the
 * template markers, and cap its size.
 */
export function sanitizeUntrusted(text: string, maxChars = MAX_PACKET_CHARS): string {
  let t = text
    .replace(/<\/?\s*case_packet\s*>/gi, '[tag removed]')
    .replace(/<<<\s*(SYSTEM|USER)\s*>>>/gi, '[marker removed]')
    .replace(/\{\{\s*(CASE_PACKET|CHAIN_FACTS)\s*\}\}/g, '[placeholder removed]');
  if (t.length > maxChars) t = `${t.slice(0, maxChars)}\n[... truncated ${t.length - maxChars} characters ...]`;
  return t;
}

export function renderUserPrompt(r: Rubric, chainFacts: Record<string, unknown>, packetText: string): string {
  const facts = Object.entries(chainFacts)
    .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  // Replace CHAIN_FACTS first: the packet is inserted last so its content is never re-scanned for placeholders.
  return r.userTemplate.replace('{{CHAIN_FACTS}}', () => facts).replace('{{CASE_PACKET}}', () => sanitizeUntrusted(packetText));
}

// ------------------------------------------------------------------ output parsing

export const VERDICTS = ['Uphold', 'Reject'] as const;
export type VerdictLabel = (typeof VERDICTS)[number];

const outputSchema = z.strictObject({
  verdict: z.enum(VERDICTS),
  confidence: z.number().finite(),
  rationale: z.string().min(1),
  citedFacts: z.array(z.string().min(1)).min(1).max(MAX_FACTS),
});

export interface JurorOutput {
  verdict: VerdictLabel;
  confidence: number;
  rationale: string;
  citedFacts: string[];
}

export type ParseResult =
  | { ok: true; value: JurorOutput; warnings: string[] }
  | { ok: false; errors: string[]; partial?: Partial<JurorOutput> };

export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Extract the single top-level JSON object from a model reply (tolerates fences / leading prose). */
export function extractJsonObject(text: string): string | null {
  const t = text.replace(/^\ufeff/, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Strict parse of the juror's reply. The schema is exact (no extra keys). Word limits are hard
 * errors so the caller can retry; `partial` carries a valid verdict if only limits failed.
 */
export function parseJurorOutput(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, errors: ['no JSON object in reply'] };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const r = outputSchema.safeParse(raw);
  if (!r.success) {
    const partial: Partial<JurorOutput> = {};
    const o = raw as Record<string, unknown>;
    if (o && (o.verdict === 'Uphold' || o.verdict === 'Reject')) partial.verdict = o.verdict;
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), partial };
  }
  const v = r.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  let confidence = v.confidence;
  if (confidence > 1 && confidence <= 100) {
    confidence = confidence / 100;
    warnings.push('confidence given as a percentage; normalized');
  }
  if (confidence < 0 || confidence > 1) errors.push('confidence must be in [0, 1]');
  if (wordCount(v.rationale) > RATIONALE_MAX_WORDS) errors.push(`rationale exceeds ${RATIONALE_MAX_WORDS} words`);
  v.citedFacts.forEach((f, i) => {
    if (wordCount(f) > FACT_MAX_WORDS) errors.push(`citedFacts.${i} exceeds ${FACT_MAX_WORDS} words`);
  });
  const value: JurorOutput = { verdict: v.verdict, confidence, rationale: v.rationale.trim(), citedFacts: v.citedFacts.map((f) => f.trim()) };
  if (errors.length) return { ok: false, errors, partial: value };
  return { ok: true, value, warnings };
}

// ------------------------------------------------------------------ screening

export interface ScreenResult {
  passed: boolean;
  reasons: string[];
}

const CODE_PATTERNS: Array<[RegExp, string]> = [
  [/`/, 'backticks'],
  [/[{}<>;]|\[\s*\]|==|!=|=>|->|::|&&|\|\|/, 'code-like punctuation'],
  [/\b(def|lambda|fn|func)\s+\w+/, 'function definition'],
  [/\b\w+\s*\([^)]*\)\s*[:{]/, 'call or signature'],
  [/\b[\w$]+\.[a-zA-Z_]\w*\s*\(/, 'method call'],
  [/^\s*(import|from|#include|package|using)\s+\S/m, 'import statement'],
  [/\b(assert|elif|kwargs|argv|stdout|stderr|pytest|unittest|__\w+__)\b|\b(None|True|False|null|undefined)\b(?!-)/, 'code keyword'],
];
const PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[\s"'(])(\.{1,2}\/|\/)[A-Za-z_][\w.-]*/, 'path'],
  [/\b[\w.-]+\/[\w.-]+\/[\w.-]+/, 'path'],
  [/\b[A-Za-z_][\w-]*\/[\w-]*[A-Za-z_][\w.-]*\/?(?=\s|$|[,.;)])/, 'path'],
  [/\b[\w-]+\.(py|pyi|js|ts|tsx|json|md|txt|sh|toml|ya?ml|lock|cfg|ini|tar|gz|zip|whl|csv|html|sol|rs|go|c|h|cpp)\b/i, 'file name'],
  [/[A-Za-z]:\\/, 'windows path'],
];
const OTHER_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/|www\.|\b[\w-]+\.(com|org|io|net|ai|dev)\b/i, 'url or domain'],
  [/\b(0x)?[0-9a-fA-F]{16,}\b/, 'long hex string'],
  [/[A-Za-z0-9+/]{28,}={0,2}/, 'possible encoded blob'],
  [/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, 'snake_case identifier'],
  [/\b[a-z]+[A-Z][a-z0-9]+[A-Za-z0-9]*\b/, 'camelCase identifier'],
  [/\btask[-_#]?[a-z]*\d+\b|\btest_\w+/i, 'task or test identifier'],
  [/ignore (all |the )?(previous|prior|above)|system prompt|as an ai|<\|/i, 'instruction-following artifact'],
  [/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/, 'control or invisible characters'],
];

function normWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Set of n-word shingles of the private corpus (task/test/source text from the case packet). */
export function shingles(texts: string[], n = 7): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const w = normWords(t);
    for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  }
  return out;
}

export interface ScreenOptions {
  maxWords: number;
  maxBytes: number;
  /** Shingles of private text that must not be copied (from `shingles`). */
  privateShingles?: Set<string>;
  shingleSize?: number;
}

/** Screen one public string (rationale or cited fact). */
export function screenText(text: string, opts: ScreenOptions): ScreenResult {
  const reasons: string[] = [];
  if (wordCount(text) > opts.maxWords) reasons.push(`more than ${opts.maxWords} words`);
  if (Buffer.byteLength(text, 'utf8') > opts.maxBytes) reasons.push(`more than ${opts.maxBytes} bytes`);
  for (const [re, why] of [...CODE_PATTERNS, ...PATH_PATTERNS, ...OTHER_PATTERNS]) if (re.test(text)) reasons.push(why);
  if (opts.privateShingles && opts.privateShingles.size) {
    const n = opts.shingleSize ?? 7;
    const w = normWords(text);
    for (let i = 0; i + n <= w.length; i++) {
      if (opts.privateShingles.has(w.slice(i, i + n).join(' '))) {
        reasons.push('copies private task/test/source text');
        break;
      }
    }
  }
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export interface ScreenedPublic {
  rationale: string;
  citedFacts: string[];
  screening: { passed: boolean; reasons: string[]; droppedFacts: number };
}

/**
 * Screen the public parts of a decision. A failing rationale is replaced by WITHHELD_RATIONALE;
 * failing facts are dropped. The vote itself is never changed by screening.
 */
export function screenDecision(out: Pick<JurorOutput, 'rationale' | 'citedFacts'>, privateShingles?: Set<string>): ScreenedPublic {
  const r = screenText(out.rationale, { maxWords: RATIONALE_MAX_WORDS, maxBytes: RATIONALE_MAX_BYTES, privateShingles });
  const facts: string[] = [];
  const factReasons: string[] = [];
  for (const f of out.citedFacts.slice(0, MAX_FACTS)) {
    const s = screenText(f, { maxWords: FACT_MAX_WORDS, maxBytes: 250, privateShingles });
    if (s.passed) facts.push(f);
    else factReasons.push(...s.reasons.map((x) => `fact: ${x}`));
  }
  const dropped = Math.min(out.citedFacts.length, MAX_FACTS) - facts.length;
  return {
    rationale: r.passed ? out.rationale : WITHHELD_RATIONALE,
    citedFacts: facts,
    screening: { passed: r.passed && dropped === 0, reasons: [...new Set([...r.reasons.map((x) => `rationale: ${x}`), ...factReasons])], droppedFacts: dropped },
  };
}

/**
 * Collect private text from a case packet for copy detection: every string leaf except those under
 * keys that hold public material (frozen description/claims, statements of the parties).
 */
export function privateCorpus(packet: unknown): string[] {
  const out: string[] = [];
  const PUBLIC_KEY = /claim|description|statement|ground|summary|title/i;
  const walk = (v: unknown, publicCtx: boolean) => {
    if (typeof v === 'string') {
      if (!publicCtx && v.length >= 40) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, publicCtx));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, publicCtx || PUBLIC_KEY.test(k));
  };
  walk(packet, false);
  return out;
}

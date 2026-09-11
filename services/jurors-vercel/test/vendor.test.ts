import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lockToken, loadConfig } from '../src/lib/config.ts';
import { PINNED_FIREWORKS_MODELS } from '../src/vendor/jurors/src/llm.ts';
import { parseRubric, renderUserPrompt } from '../src/vendor/jurors/src/rubric.ts';
import { PROMPT_SHA256, PROMPT_TEXT } from '../src/vendor/prompt-text.ts';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

describe('vendored juror logic', () => {
  it('bundled prompt text hashes to the reference juror prompt (juror-v1)', () => {
    const file = readFileSync(repo('services/jurors/prompts/juror-v1.md'));
    const sha = `0x${createHash('sha256').update(file).digest('hex')}`;
    expect(PROMPT_SHA256).toBe(sha);
    const r = parseRubric(PROMPT_TEXT);
    expect(r.hash).toBe(sha);
    expect(r.version).toBe('juror-v1');
    expect(renderUserPrompt(r, { disputeId: '1' }, '{"x":1}')).toContain('<case_packet>');
  });

  it('keeps the spec model pins', () => {
    expect(PINNED_FIREWORKS_MODELS).toEqual({
      1: 'accounts/fireworks/models/deepseek-v4p1-flash',
      2: 'accounts/fireworks/models/gpt-oss-120b',
      3: 'accounts/fireworks/models/glm-5p2',
    });
  });

  it('defaults to the live Base Sepolia deployment, disabled unless JURORS_ENABLED=1', () => {
    const cfg = loadConfig({});
    expect(cfg.chainId).toBe(84532);
    expect(cfg.market.toLowerCase()).toBe('0x2fd644342296df7de57929fa87bd65c05fb415f8');
    expect(cfg.enabled).toBe(false);
    expect(loadConfig({ JURORS_ENABLED: '1' }).enabled).toBe(true);
    expect(lockToken(cfg, 5n)).toBe('envmarket-jurors:84532:0x2fd644342296df7de57929fa87bd65c05fb415f8:5');
    expect(new TextEncoder().encode(lockToken(cfg, 2n ** 255n)).length).toBeLessThan(255);
  });
});

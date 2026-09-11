import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@envmarket/shared';
import { AGENT_TOOLS, estimatePromptTokens, promptDigest, renderTaskMessage } from '../src/harness.ts';

describe('harness', () => {
  it('prompt-token estimate is conservative (3 chars/token) and grows with history', () => {
    const base: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(3000) }];
    const a = estimatePromptTokens(base);
    expect(a).toBeGreaterThanOrEqual(1000 + Math.floor(JSON.stringify(AGENT_TOOLS).length / 3));
    const b = estimatePromptTokens([...base, { role: 'tool', tool_call_id: 'c1', content: 'y'.repeat(12_000) }]);
    expect(b - a).toBeGreaterThanOrEqual(4000);
  });
  it('prompt digest is stable; the task message carries only public task data', () => {
    expect(promptDigest()).toBe(promptDigest());
    const m = renderTaskMessage({
      title: 'LRUCache evicts entries that were just read',
      statement: 'Fix the recency order.',
      files: ['ledgerlite/lru.py', 'visible_tests/test_visible.py', 'pytest.ini'],
      editable: ['ledgerlite/*.py'],
      visibleTestCmd: 'python -m pytest -q visible_tests',
      actionBudget: 12,
      timeBudgetSec: 300,
    });
    expect(m).toContain('12 tool actions (submit is free)');
    expect(m).toContain('ledgerlite/*.py');
    expect(m).not.toMatch(/hidden|tests\/test_hidden|solution/i);
  });
  it('exposes exactly the five protocol tools', () => {
    expect(AGENT_TOOLS.map((t) => t.function.name)).toEqual(['list_files', 'read_file', 'write_file', 'run_visible_tests', 'submit']);
  });
});

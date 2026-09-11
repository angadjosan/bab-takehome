import { describe, expect, it } from 'vitest';
import { buildScreeningIndex, screenExplanation } from '../src/validator.ts';

const idx = buildScreeningIndex({
  files: [
    { path: 'src/ledgerlite/lru.py', text: 'class LRUCache:\n    """Least recently used cache keyed by account id that evicts the oldest entry first."""\n' },
    { path: 'Dockerfile.runner', text: 'FROM python:3.12-slim\nRUN pip install pytest\n' },
    { path: 'tasks/T1/tests/test_hidden.py', text: 'def test_get_marks_key_most_recently_used():\n    pass\n' },
    { path: 'grader/tasks.py', text: 'PYTEST_INI = "[pytest]"\n' },
  ],
  taskIds: ['T1', 'A1'],
  publicTexts: [
    'ledgerlite, a small stdlib-only Python 3.12 bookkeeping library. The runner image is built from Dockerfile.runner; graders run with PYTHONHASHSEED=0 and a generated pytest.ini.',
  ],
});

describe('validator output screening', () => {
  it('passes ordinary prose with semicolons and names the seller already published', () => {
    const text =
      'Observed: Dockerfile.runner pins the base image by digest and runs as a non-root user; verification scripts apply offline limits. ' +
      'Observed: the ledgerlite library uses only the standard library and grading sets PYTHONHASHSEED=0.';
    expect(screenExplanation(text, idx)).toEqual({ passed: true, reasons: [] });
  });
  it.each([
    ['private class name', 'The LRUCache class is tidy.'],
    ['hidden test file name', 'Coverage in test_hidden looks thorough.'],
    ['braces', 'Uses a {dict} for state.'],
    ['private path', 'See grader/tasks.py for details.'],
    ['copied private span', 'Least recently used cache keyed by account id that evicts the oldest entry first.'],
    ['task id', 'A1 is harder than the rest.'],
  ])('still screens out %s', (_label, text) => {
    expect(screenExplanation(text, idx).passed).toBe(false);
  });
});

/** A small, self-contained seller workspace for tests (independent of seller-workspace/). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Z = `0x${'00'.repeat(32)}`;

export function tmpDir(prefix = 'agents-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function put(root: string, rel: string, content: string, mode?: number): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mode) fs.chmodSync(p, mode);
}

export const FIXTURE_VERSION = 'fixture-kit-1.0.0';

export function manifestTemplate(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    environmentType: 'coding',
    name: 'fixture-kit',
    environmentVersion: FIXTURE_VERSION,
    bundleDigest: Z,
    imageDigest: Z,
    imageRef: 'placeholder',
    taskRoot: Z,
    taskCount: 1,
    auditRoot: Z,
    auditTaskCount: 0,
    entrypoints: { reset: 'grader.env:reset', step: 'grader.env:step', grade: 'grader.env:grade', close: 'grader.env:close' },
    schemas: { observation: 'text', action: 'text', gradeResult: 'json' },
    grader: { entrypoint: 'python -m grader.run', dependencies: ['pytest'], version: '1', digest: Z, externalJudge: null },
    resources: { cpu: 1, memoryMb: 512, accelerator: null, diskMb: 256, episodeTimeoutSec: 600, actionBudget: 12, concurrency: 1 },
    determinism: { randomnessSources: [], seedPolicy: 'fixed', supportedRuntimes: ['python3.12'], resultsMayVary: false },
    networkPolicy: { mode: 'offline', externalDependencies: [] },
    referenceProtocol: {
      id: 'fixture-protocol-1',
      models: [{ requested: 'GLM 5.3', artifact: null }],
      harness: 'scripted',
      decoding: { temperature: 0, seed: 1, maxTokens: 1000 },
      taskSelection: 'all purchased tasks',
      actionBudget: 12,
      timeBudgetSec: 600,
      successRule: 'all hidden tests pass',
    },
    license: { id: 'EnvMarket-NE-1', summary: 'non-exclusive internal training', exclusive: false, redistribution: false },
    provenance: { authors: ['fixture'], upstreamSources: [], funders: [] },
    conflicts: { relatedParties: [], disclosures: [] },
    commercialTerms: {
      currency: 'tUSDC',
      decimals: 6,
      price: '100000000',
      perTaskAllocation: 'equal',
      deliveryWindowSec: 600,
      challengeWindowSec: 300,
      refundCapBps: 5000,
      collateral: '100000000',
    },
  };
}

export function makeWorkspace(opts: { extraFiles?: Record<string, string> } = {}): string {
  const ws = tmpDir('fixture-ws-');
  put(ws, 'src/kit/__init__.py', '');
  put(ws, 'src/kit/core.py', 'def add(a, b):\n    return a - b\n');
  for (const id of ['T1', 'T2', 'T3']) {
    put(ws, `tasks/${id}/task.json`, JSON.stringify({ taskId: id, statement: `fix ${id}` }));
    put(ws, `tasks/${id}/tests/test_hidden.py`, `from kit.core import add\n\ndef test_${id}_a():\n    assert add(1, 2) == 3\n`);
  }
  put(ws, 'tasks/T1/__pycache__/junk.pyc', 'x'); // must be excluded
  put(ws, 'audit-tasks/A1/task.json', JSON.stringify({ taskId: 'A1', statement: 'secret audit task' }));
  put(ws, 'audit-tasks/A1/tests/test_hidden.py', 'def test_audit():\n    assert True\n');
  put(ws, 'grader/run.py', 'print("grade")\n');
  put(ws, 'grader/run.sh', '#!/bin/sh\necho grade\n', 0o755);
  put(ws, 'solutions/T1.patch', '--- a\n+++ b\n');
  put(ws, 'requirements.lock', 'pytest==8.3.3\n');
  put(ws, 'IMAGE_DIGEST', `python:3.12-slim@sha256:${'ab'.repeat(32)}\n`);
  put(ws, 'LICENSE', 'Fixture license: non-exclusive internal training.\n');
  put(ws, 'SEEDED_DISPUTE.md', 'seller private notes: never packaged\n');
  put(
    ws,
    'listing/description.json',
    JSON.stringify({
      schemaVersion: '1',
      title: 'Fixture kit',
      environmentVersion: FIXTURE_VERSION,
      claims: [{ id: 'C1', text: 'Contains exactly 3 purchased tasks.', category: 'tasks', checkable: true }],
    }),
  );
  put(ws, 'listing/description.md', '# Fixture kit\n');
  put(ws, 'listing/manifest.template.json', JSON.stringify(manifestTemplate(), null, 2));
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) put(ws, rel, content);
  return ws;
}

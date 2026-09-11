/** Packages the real seller workspace (skipped if it is not present / incomplete). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTar, sha256Hex } from '@envmarket/shared';
import { REPO_ROOT } from '../src/common/paths.ts';
import { packageEnvironment } from '../src/seller/package.ts';
import { tmpDir } from './fixture.ts';

const WS = path.join(REPO_ROOT, 'seller-workspace', 'py-repair-kit');
const ready = ['listing/description.json', 'listing/manifest.template.json', 'IMAGE_DIGEST', 'grader', 'tasks', 'requirements.lock'].every((p) => fs.existsSync(path.join(WS, p)));

describe.skipIf(!ready)('real seller workspace (seller-workspace/py-repair-kit)', () => {
  it('packages into a schema-valid manifest with the full purchased payload and nothing private', () => {
    const r = packageEnvironment({ workspace: WS, outDir: path.join(tmpDir(), 'v'), price: 100_000_000n, collateral: 100_000_000n });
    expect(r.listing.taskIds).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(r.manifest.taskCount).toBe(5);
    expect((r.manifest as Record<string, unknown>).taskIds).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(r.manifest.auditTaskCount).toBe(2);
    expect(r.manifest.imageRef).toMatch(/^python:3\.12-slim@sha256:[0-9a-f]{64}$/);
    const paths = readTar(new Uint8Array(fs.readFileSync(path.join(r.outDir, 'bundle.tar')))).map((e) => e.path);
    for (const must of [
      'manifest.json',
      'src/ledgerlite/lru.py',
      'tasks/T1/task.json',
      'tasks/T1/tests/test_hidden.py',
      'tasks/T1/visible_tests/test_visible.py',
      'grader/grade.py',
      'requirements.lock',
      'IMAGE_DIGEST',
      'Dockerfile.runner',
      'scripts/verify.sh',
      'LICENSE-ENV.md',
      'provenance.json',
      'listing/description.json',
    ]) {
      expect(paths, must).toContain(must);
    }
    expect(paths.some((p) => p.startsWith('solutions/T5/'))).toBe(true);
    expect(paths.some((p) => /audit/i.test(p))).toBe(false);
    expect(paths.some((p) => p.includes('SEEDED_DISPUTE'))).toBe(false);
    expect(sha256Hex(fs.readFileSync(path.join(WS, 'listing/description.json')))).toBe(r.listing.versionInput.descriptionHash);
    expect(sha256Hex(fs.readFileSync(path.join(WS, 'LICENSE-ENV.md')))).toBe(r.listing.versionInput.licenseHash);
  });
});

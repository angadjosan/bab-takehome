import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  AUDIT_DOMAIN,
  buildTaskTree,
  decryptFile,
  extractTar,
  graderDigestOfDir,
  readTar,
  sha256Hex,
  taskHashOfDir,
} from '@envmarket/shared';
import { packageEnvironment, parseImageDigest, readKeys, readSalts } from '../src/seller/package.ts';
import { FIXTURE_VERSION, makeWorkspace, tmpDir } from './fixture.ts';

const fixedSalts = {
  tasks: { T1: `0x${'11'.repeat(32)}`, T2: `0x${'22'.repeat(32)}`, T3: `0x${'33'.repeat(32)}` } as Record<string, Hex>,
  audit: { A1: `0x${'aa'.repeat(32)}` } as Record<string, Hex>,
};

describe('seller packaging', () => {
  it('is deterministic: same inputs and salts → same bundleHash, roots and manifest', () => {
    const ws = makeWorkspace();
    const a = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v'), salts: fixedSalts });
    const b = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v'), salts: fixedSalts });
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(a.listing.versionInput.manifestHash).toBe(b.listing.versionInput.manifestHash);
    expect(a.listing.versionInput.taskRoot).toBe(b.listing.versionInput.taskRoot);
    expect(a.listing.versionInput.auditRoot).toBe(b.listing.versionInput.auditRoot);
    expect(a.listing.versionInput.descriptionHash).toBe(b.listing.versionInput.descriptionHash);
    // fresh keys + nonces: ciphertexts differ even though plaintext is identical
    expect(a.listing.versionInput.ciphertextHash).not.toBe(b.listing.versionInput.ciphertextHash);
    expect(fs.readFileSync(path.join(a.outDir, 'bundle.tar')).equals(fs.readFileSync(path.join(b.outDir, 'bundle.tar')))).toBe(true);
  });

  it('bundleHash changes when a salt changes (salts feed taskRoot, which the manifest commits to)', () => {
    const ws = makeWorkspace();
    const a = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v'), salts: fixedSalts });
    const b = packageEnvironment({
      workspace: ws,
      outDir: path.join(tmpDir(), 'v'),
      salts: { ...fixedSalts, tasks: { ...fixedSalts.tasks, T2: `0x${'23'.repeat(32)}` } },
    });
    expect(a.listing.versionInput.taskRoot).not.toBe(b.listing.versionInput.taskRoot);
    expect(a.bundleHash).not.toBe(b.bundleHash);
  });

  it('fresh random salts are generated per task and differ between runs', () => {
    const ws = makeWorkspace();
    const a = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v') });
    const b = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v') });
    const sa = readSalts(a.outDir);
    const sb = readSalts(b.outDir);
    expect(new Set(Object.values(sa.tasks)).size).toBe(3);
    expect(sa.tasks.T1).not.toBe(sb.tasks.T1);
    expect(a.bundleHash).not.toBe(b.bundleHash);
  });

  it('reproduces task leaves + taskRoot from the delivered payload and salts, and auditRoot from the audit asset', () => {
    const ws = makeWorkspace();
    const r = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v') });
    const keys = readKeys(r.outDir);
    const salts = readSalts(r.outDir);
    const plain = decryptFile(keys.bundleKey, new Uint8Array(fs.readFileSync(path.join(r.outDir, 'bundle.enc'))));
    expect(sha256Hex(plain)).toBe(r.bundleHash);
    const dest = tmpDir('extract-');
    extractTar(plain, dest);
    const graderDigest = graderDigestOfDir(path.join(dest, 'grader'));
    expect(graderDigest).toBe(r.manifest.grader.digest);
    const tree = buildTaskTree({
      environmentVersion: FIXTURE_VERSION,
      graderDigest,
      tasks: ['T1', 'T2', 'T3'].map((id) => ({ taskId: id, taskHash: taskHashOfDir(path.join(dest, 'tasks', id)), salt: salts.tasks[id] as Hex })),
    });
    expect(tree.root).toBe(r.listing.versionInput.taskRoot);
    expect(tree.root).toBe(r.manifest.taskRoot);

    const auditPlain = decryptFile(keys.auditKey, new Uint8Array(fs.readFileSync(path.join(r.outDir, 'audit.enc'))));
    const auditDest = tmpDir('audit-');
    extractTar(auditPlain, auditDest);
    const auditTree = buildTaskTree({
      environmentVersion: FIXTURE_VERSION,
      graderDigest,
      domain: AUDIT_DOMAIN,
      tasks: [{ taskId: 'A1', taskHash: taskHashOfDir(path.join(auditDest, 'A1')), salt: salts.audit!.A1 as Hex }],
    });
    expect(auditTree.root).toBe(r.listing.versionInput.auditRoot);
    expect(r.listing.versionInput.auditTaskCount).toBe(1);
  });

  it('excludes audit tasks, seller notes and caches; uses separate keys for bundle and audit', () => {
    const ws = makeWorkspace();
    const r = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v') });
    const paths = readTar(new Uint8Array(fs.readFileSync(path.join(r.outDir, 'bundle.tar')))).map((e) => e.path);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('tasks/T1/tests/test_hidden.py');
    expect(paths).toContain('solutions/T1.patch');
    expect(paths).toContain('requirements.lock');
    expect(paths).toContain('IMAGE_DIGEST');
    expect(paths.some((p) => p.includes('audit'))).toBe(false);
    expect(paths.some((p) => p.includes('SEEDED_DISPUTE'))).toBe(false);
    expect(paths.some((p) => p.includes('__pycache__'))).toBe(false);
    // public listing docs ship with the product (environment builder's delivery list)
    expect(paths).toContain('listing/description.json');
    const keys = readKeys(r.outDir);
    expect(keys.bundleKey).not.toBe(keys.auditKey);
    expect(() => decryptFile(keys.bundleKey, new Uint8Array(fs.readFileSync(path.join(r.outDir, 'audit.enc'))))).toThrow();
  });

  it('commits public docs by hash and fills the manifest', () => {
    const ws = makeWorkspace();
    const r = packageEnvironment({ workspace: ws, outDir: path.join(tmpDir(), 'v'), price: 7_000_000n, collateral: 9_000_000n, challengeWindowSec: 120 });
    const v = r.listing.versionInput;
    expect(sha256Hex(fs.readFileSync(path.join(r.outDir, 'public/description.json')))).toBe(v.descriptionHash);
    expect(sha256Hex(fs.readFileSync(path.join(r.outDir, 'public/manifest.json')))).toBe(v.manifestHash);
    expect(sha256Hex(fs.readFileSync(path.join(r.outDir, 'public/LICENSE')))).toBe(v.licenseHash);
    expect(sha256Hex(fs.readFileSync(path.join(r.outDir, 'bundle.enc')))).toBe(v.ciphertextHash);
    expect(v.imageDigest).toBe(`0x${'ab'.repeat(32)}`);
    expect(v.taskCount).toBe(3);
    expect(v.price).toBe('7000000');
    expect(v.collateral).toBe('9000000');
    expect(v.challengeWindow).toBe(120);
    expect(r.manifest.taskCount).toBe(3);
    expect(r.manifest.commercialTerms.price).toBe('7000000');
  });

  it('refuses to overwrite a packaged version without force', () => {
    const ws = makeWorkspace();
    const out = path.join(tmpDir(), 'v');
    packageEnvironment({ workspace: ws, outDir: out });
    expect(() => packageEnvironment({ workspace: ws, outDir: out })).toThrow(/exists/);
  });

  it('requires an immutable image digest', () => {
    expect(() => parseImageDigest('python:3.12-slim')).toThrow();
    expect(parseImageDigest(`python:3.12-slim@sha256:${'cd'.repeat(32)}`).digest).toBe(`0x${'cd'.repeat(32)}`);
  });
});

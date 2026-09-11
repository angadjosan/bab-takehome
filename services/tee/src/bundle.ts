/**
 * Seller upload: unwrap keys, decrypt, verify every commitment, run the build/dependency
 * preflight in the sandbox, and store the private record.
 *
 * POST /seller/upload body (JSON; binary fields base64):
 *   encryptedBundle   EMENC1(K_bundle, canonical tar)              → ciphertextHash
 *   encryptedAudit    EMENC1(K_audit, canonical tar of audit-tasks/)
 *   wrappedBundleKey  shared wrapKey (EMKW2 = HPKE) to the TEE X25519 key (/health encPubKey),
 *                     wrapperHash (HPKE aad) = ciphertextHash, info = "envmarket.upload.v1"
 *                     ("envmarket.keywrap.v1" also accepted)
 *   wrappedAuditKey   same, same salt (sha256 of the audit ciphertext also accepted)
 *   encryptedSalts    EMENC1(K_audit, salts.json)  — or EMENC1(K_salts) with `wrappedSaltsKey`
 *   wrappedSaltsKey?  optional EMKW1 of K_salts (same salt/info rules)
 *   publicDocs        { "description.json", "manifest.json", "description.md"?, "license"? } (utf8 text or {base64})
 *   claims?           { bundleHash, taskRoot, auditRoot, taskCount, auditTaskCount, environmentVersion,
 *                       descriptionHash, manifestHash, licenseHash, imageDigest } — every given field is checked
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AUDIT_DOMAIN,
  KEYWRAP_INFO,
  TASK_DOMAIN,
  UPLOAD_KEYWRAP_INFO,
  buildTaskTree,
  bundleDigestOfDir,
  bytesToHex,
  decryptFile,
  extractTar,
  fromBase64,
  graderDigestOfDir,
  parseDescription,
  parseManifest,
  readTar,
  saltsFileSchema,
  sha256Hex,
  taskHashOfDir,
  unwrapKeyAsync,
  writeTar,
  type SaltsFile,
} from '@envmarket/shared';
import type { Hex } from 'viem';
import type { Ctx } from './context.ts';
import { errMsg, logger } from './log.ts';
import { NETDENY, RUNTIME_DIR, grantDir, nextUid, prepareVenv, runSandboxed, scratchDir } from './sandbox.ts';
import { buildValidatorInput, collectFiles } from './validator.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface TaskCheckRow {
  taskId: string;
  ok: boolean;
  error?: string;
  hiddenTestCount?: number;
  hiddenTestFiles?: string[];
  start?: { passed: number; failed: number; collected: number; allPassed: boolean; timedOut: boolean };
  solution?: { present: boolean; passed?: number; failed?: number; collected?: number; allPassed?: boolean; timedOut?: boolean; failedTests?: string[]; files?: string[] };
}

export interface TaskCheckOutput {
  python: string;
  imports: { ok: boolean; error?: string; pytest?: string; environmentVersion?: string };
  tasks: TaskCheckRow[];
}

export interface PreflightResult {
  /** everything passed, including reference solutions */
  ok: boolean;
  /** dependencies install, grader imports, every task's hidden tests collect (gate for previews) */
  buildOk: boolean;
  dependencies: { ok: boolean; venv: string; log: string };
  imports: TaskCheckOutput['imports'] | null;
  purchased: Array<{ taskId: string; hiddenTestCount: number | null; startFails: boolean; referenceSolutionPasses: boolean | null; error?: string }>;
  audit: Array<{ taskId: string; hiddenTestCount: number | null; startFails: boolean; referenceSolutionPasses: boolean | null; error?: string }>;
  sandbox: string;
  ranAt: string;
}

export interface UploadRecord {
  uploadId: Hex;
  environmentVersion: string;
  bundleHash: Hex;
  ciphertextHash: Hex;
  auditCiphertextHash: Hex;
  manifestHash: Hex;
  descriptionHash: Hex;
  descriptionMdHash: Hex | null;
  licenseHash: Hex | null;
  taskRoot: Hex;
  auditRoot: Hex;
  taskIds: string[];
  auditTaskIds: string[];
  imageDigest: Hex;
  imageRef: string;
  graderDigest: Hex;
  bundleDigest: Hex;
  requirementsLock: string;
  /** length of the validator input built from this bundle (quotes) */
  validatorInputChars?: number;
  bundleKey: Hex;
  auditKey: Hex;
  salts: SaltsFile;
  preflight: PreflightResult;
  checks: Check[];
  createdAt: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly checks: Check[],
    readonly status = 400,
  ) {
    super(message);
  }
}

type DocValue = string | { base64: string } | { utf8: string };

function docBytes(v: DocValue | undefined): Uint8Array | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if ('base64' in v) return fromBase64(v.base64);
  if ('utf8' in v) return new TextEncoder().encode(v.utf8);
  return null;
}

function b64(v: unknown, name: string): Uint8Array {
  if (typeof v !== 'string' || v.length === 0) throw new UploadError(`missing ${name} (base64)`, [{ name, ok: false, detail: 'missing' }]);
  return fromBase64(v);
}

/** Try the accepted (salt, info) combinations for an upload key wrap. */
async function unwrapUploadKey(ctx: Ctx, blob: Uint8Array, salts: Hex[]): Promise<Uint8Array> {
  const errors: string[] = [];
  for (const salt of salts) {
    for (const info of [UPLOAD_KEYWRAP_INFO, KEYWRAP_INFO]) {
      try {
        const k = await unwrapKeyAsync({ blob, recipientSecretKey: ctx.keys.encSecretKey, wrapperHash: salt, info });
        if (k.length === 32) return k;
      } catch (e) {
        errors.push(errMsg(e));
      }
    }
  }
  throw new Error(`cannot unwrap key with the TEE X25519 key (${errors[0] ?? 'unknown'})`);
}

function listTaskDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'task.json')))
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * IMAGE_DIGEST: either a bare immutable reference (`<image>@sha256:<64 hex>`) on the first line, or
 * `key=value` lines where `base=` (or `ref=`) names the immutable reference (`image=` may carry the
 * locally built runner image id, `dockerfile_sha256=` the Dockerfile hash). `#` comments ignored.
 * Same rule as the seller packager (agents/src/common/image.ts).
 */
export function parseImageRef(text: string): { ref: string; digest: Hex; fields: Record<string, string> } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const fields: Record<string, string> = {};
  for (const l of lines) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  const candidate = fields.base ?? fields.ref ?? (Object.keys(fields).length === 0 ? lines[0] : undefined);
  const m = candidate ? /^[^\s@]+@sha256:([0-9a-f]{64})$/.exec(candidate) : null;
  return candidate && m ? { ref: candidate, digest: `0x${m[1]}` as Hex, fields } : null;
}

/** Decrypt + verify + extract the purchased bundle into a fresh dir (readable by sandbox uids). */
export function openBundle(ctx: Ctx, rec: Pick<UploadRecord, 'ciphertextHash' | 'bundleHash' | 'bundleKey'>, label: string): { dir: string; checks: Check[] } {
  const checks: Check[] = [];
  const ct = ctx.blobs.get(rec.ciphertextHash);
  checks.push({ name: 'ciphertext.present', ok: !!ct });
  if (!ct) throw new UploadError('bundle ciphertext missing from storage', checks, 500);
  const ctHash = sha256Hex(ct);
  checks.push({ name: 'ciphertext.sha256', ok: ctHash === rec.ciphertextHash, detail: ctHash });
  let tar: Uint8Array;
  try {
    tar = decryptFile(rec.bundleKey, ct);
    checks.push({ name: 'bundle.decrypt', ok: true });
  } catch (e) {
    checks.push({ name: 'bundle.decrypt', ok: false, detail: errMsg(e) });
    throw new UploadError('bundle does not decrypt with the committed key', checks);
  }
  const bh = sha256Hex(tar);
  checks.push({ name: 'bundle.sha256', ok: bh === rec.bundleHash, detail: bh });
  const dir = scratchDir(ctx.workRoot, `bundle-${label}`);
  fs.rmSync(dir, { recursive: true, force: true });
  extractTar(tar, dir);
  return { dir, checks };
}

export function openAudit(ctx: Ctx, rec: Pick<UploadRecord, 'uploadId' | 'auditCiphertextHash' | 'auditKey'>, label: string): string {
  const ct = ctx.priv.getBytes('audit-ct', rec.uploadId.slice(2));
  if (!ct || sha256Hex(ct) !== rec.auditCiphertextHash) throw new Error('audit ciphertext missing or corrupted');
  const tar = decryptFile(rec.auditKey, ct);
  const dir = scratchDir(ctx.workRoot, `audit-${label}`);
  fs.rmSync(dir, { recursive: true, force: true });
  extractTar(tar, dir);
  return dir;
}

/** Run runtime/check_tasks.py for `taskIds` inside the sandbox. */
export async function runTaskChecks(
  ctx: Ctx,
  venv: string,
  kitDir: string,
  taskRoots: string[],
  taskIds: string[],
  solutionsDir: string | null,
  timeoutSec = 900,
): Promise<{ output: TaskCheckOutput | null; raw: string; error: string | null }> {
  const uid = nextUid(ctx.sandbox);
  const tmp = scratchDir(ctx.workRoot, 'chk-tmp');
  for (const d of [kitDir, ...taskRoots, ...(solutionsDir ? [solutionsDir] : [])]) grantDir(ctx.sandbox, d, uid, false);
  grantDir(ctx.sandbox, tmp, uid, true);
  const args = [path.join(RUNTIME_DIR, 'check_tasks.py'), '--kit', kitDir, '--tasks', taskIds.join(',')];
  for (const r of taskRoots) args.push('--task-root', r);
  if (solutionsDir) args.push('--solutions', solutionsDir);
  const res = await runSandboxed(ctx.sandbox, {
    args,
    cwd: kitDir,
    readDirs: [kitDir, ...taskRoots, ...(solutionsDir ? [solutionsDir] : []), RUNTIME_DIR],
    writeDirs: [tmp],
    env: ctx.sandbox.kind === 'linux-root' ? { TMPDIR: tmp, HOME: tmp } : {},
    timeoutSec,
    venv,
    uid,
    label: 'check-tasks',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  const raw = (res.stdout + '\n' + res.stderr).slice(-6000);
  if (res.timedOut) return { output: null, raw, error: `task checks timed out after ${timeoutSec}s` };
  const line = res.stdout.trim().split('\n').filter(Boolean).pop();
  try {
    return { output: JSON.parse(line ?? '') as TaskCheckOutput, raw, error: null };
  } catch {
    return { output: null, raw, error: `task checker crashed (exit ${res.code})` };
  }
}

void NETDENY;

function summarizeRows(rows: TaskCheckRow[]): PreflightResult['purchased'] {
  return rows.map((r) => ({
    taskId: r.taskId,
    hiddenTestCount: r.hiddenTestCount ?? null,
    startFails: !!r.start && !r.start.allPassed,
    referenceSolutionPasses: r.solution?.present ? !!r.solution.allPassed : null,
    ...(r.error ? { error: r.error } : {}),
  }));
}

export async function processUpload(ctx: Ctx, body: Record<string, any>): Promise<{ record: UploadRecord; response: Record<string, unknown> }> {
  const checks: Check[] = [];
  const need = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
    return ok;
  };
  const encBundle = b64(body.encryptedBundle, 'encryptedBundle');
  const encAudit = b64(body.encryptedAudit, 'encryptedAudit');
  const ciphertextHash = sha256Hex(encBundle);
  const auditCiphertextHash = sha256Hex(encAudit);
  const claims = (body.claims ?? {}) as Record<string, unknown>;
  const claim = (k: string, actual: unknown) => {
    if (claims[k] === undefined || claims[k] === null) return;
    const want = typeof claims[k] === 'string' ? String(claims[k]).toLowerCase() : claims[k];
    const got = typeof actual === 'string' ? actual.toLowerCase() : actual;
    need(`claim.${k}`, want === got, `claimed ${String(claims[k])}, computed ${String(actual)}`);
  };
  claim('ciphertextHash', ciphertextHash);

  // ------------------------------------------------------------------ keys
  let bundleKey: Uint8Array;
  let auditKey: Uint8Array;
  try {
    bundleKey = await unwrapUploadKey(ctx, b64(body.wrappedBundleKey, 'wrappedBundleKey'), [ciphertextHash]);
    need('keys.bundle.unwrap', true);
  } catch (e) {
    need('keys.bundle.unwrap', false, errMsg(e));
    throw new UploadError('wrappedBundleKey does not unwrap with the TEE key (salt must be the bundle ciphertext sha256)', checks);
  }
  try {
    auditKey = await unwrapUploadKey(ctx, b64(body.wrappedAuditKey, 'wrappedAuditKey'), [ciphertextHash, auditCiphertextHash]);
    need('keys.audit.unwrap', true);
  } catch (e) {
    need('keys.audit.unwrap', false, errMsg(e));
    throw new UploadError('wrappedAuditKey does not unwrap with the TEE key', checks);
  }
  need('keys.independent', bytesToHex(bundleKey) !== bytesToHex(auditKey));

  // ------------------------------------------------------------------ bundle
  let tar: Uint8Array;
  try {
    tar = decryptFile(bundleKey, encBundle);
    need('bundle.decrypt', true);
  } catch (e) {
    need('bundle.decrypt', false, errMsg(e));
    throw new UploadError('bundle ciphertext does not decrypt', checks);
  }
  const bundleHash = sha256Hex(tar);
  claim('bundleHash', bundleHash);
  let canonical = false;
  try {
    const entries = readTar(tar);
    canonical = sha256Hex(writeTar(entries.map((e) => ({ path: e.path, type: e.type, data: e.data, executable: (e.mode & 0o111) !== 0 })))) === bundleHash;
    need('bundle.canonicalTar', canonical, canonical ? undefined : 'archive is not in canonical ustar form');
    const top = new Set(entries.map((e) => e.path.split('/')[0]!));
    for (const req of ['manifest.json', 'src', 'tasks', 'grader', 'requirements.lock', 'IMAGE_DIGEST']) need(`bundle.contains.${req}`, top.has(req));
    need('bundle.noAuditTasks', !top.has('audit-tasks') && !entries.some((e) => /(^|\/)salts\.json$|(^|\/)keys\.json$/.test(e.path)));
  } catch (e) {
    need('bundle.readTar', false, errMsg(e));
    throw new UploadError('bundle is not a valid tar archive', checks);
  }

  const label = ciphertextHash.slice(2, 14);
  const payload = scratchDir(ctx.workRoot, `upload-${label}`);
  fs.rmSync(payload, { recursive: true, force: true });
  extractTar(tar, payload);
  const auditDir = scratchDir(ctx.workRoot, `upload-audit-${label}`);
  try {
    // ---------------------------------------------------------------- manifest
    const manifestText = fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8');
    const manifestHash = sha256Hex(manifestText);
    claim('manifestHash', manifestHash);
    let manifest;
    try {
      manifest = parseManifest(manifestText);
      need('manifest.schema', true);
    } catch (e) {
      need('manifest.schema', false, errMsg(e).slice(0, 800));
      throw new UploadError('manifest.json does not match the manifest schema', checks);
    }
    const environmentVersion = manifest.environmentVersion;
    claim('environmentVersion', environmentVersion);
    const taskIds = listTaskDirs(path.join(payload, 'tasks'));
    need('manifest.taskCount', manifest.taskCount === taskIds.length, `manifest ${manifest.taskCount}, bundle ${taskIds.length}`);
    claim('taskCount', taskIds.length);
    const declaredIds = (manifest as Record<string, unknown>).taskIds;
    if (Array.isArray(declaredIds)) need('manifest.taskIds', JSON.stringify(declaredIds) === JSON.stringify(taskIds), `manifest ${JSON.stringify(declaredIds)}, bundle ${JSON.stringify(taskIds)}`);
    const bundleDigest = bundleDigestOfDir(payload);
    need('manifest.bundleDigest', bundleDigest === manifest.bundleDigest, bundleDigest);
    const graderDigest = graderDigestOfDir(path.join(payload, 'grader'));
    need('manifest.grader.digest', graderDigest === manifest.grader.digest, graderDigest);
    const img = parseImageRef(fs.readFileSync(path.join(payload, 'IMAGE_DIGEST'), 'utf8'));
    need('image.immutableRef', !!img, img?.ref);
    need('manifest.imageDigest', !!img && img.digest === manifest.imageDigest);
    need('manifest.imageRef', !!img && img.ref === manifest.imageRef);
    claim('imageDigest', manifest.imageDigest);
    for (const id of taskIds) {
      const tj = JSON.parse(fs.readFileSync(path.join(payload, 'tasks', id, 'task.json'), 'utf8')) as { taskId?: string };
      need(`task.${id}.taskJson`, tj.taskId === id);
      need(`task.${id}.hiddenTests`, fs.existsSync(path.join(payload, 'tasks', id, 'tests')));
    }

    // ---------------------------------------------------------------- audit asset
    let auditTar: Uint8Array;
    try {
      auditTar = decryptFile(auditKey, encAudit);
      need('audit.decrypt', true);
    } catch (e) {
      need('audit.decrypt', false, errMsg(e));
      throw new UploadError('audit ciphertext does not decrypt', checks);
    }
    fs.rmSync(auditDir, { recursive: true, force: true });
    let auditTaskIds: string[] = [];
    if (manifest.auditTaskCount > 0) {
      extractTar(auditTar, auditDir);
      auditTaskIds = listTaskDirs(auditDir);
    } else fs.mkdirSync(auditDir, { recursive: true });
    need('manifest.auditTaskCount', manifest.auditTaskCount === auditTaskIds.length, `manifest ${manifest.auditTaskCount}, asset ${auditTaskIds.length}`);
    claim('auditTaskCount', auditTaskIds.length);
    need('audit.disjoint', !auditTaskIds.some((a) => taskIds.includes(a)));

    // ---------------------------------------------------------------- salts + roots
    let salts: SaltsFile;
    try {
      const saltsKey = body.wrappedSaltsKey ? await unwrapUploadKey(ctx, b64(body.wrappedSaltsKey, 'wrappedSaltsKey'), [ciphertextHash, auditCiphertextHash]) : auditKey;
      salts = saltsFileSchema.parse(JSON.parse(new TextDecoder().decode(decryptFile(saltsKey, b64(body.encryptedSalts, 'encryptedSalts')))));
      need('salts.decrypt', true);
    } catch (e) {
      need('salts.decrypt', false, errMsg(e));
      throw new UploadError('encryptedSalts does not decrypt (EMENC1 under K_audit, or K_salts wrapped as wrappedSaltsKey)', checks);
    }
    need('salts.environmentVersion', salts.environmentVersion === environmentVersion);
    const missingSalts = [...taskIds.filter((t) => !salts.tasks[t]), ...auditTaskIds.filter((t) => !salts.audit?.[t])];
    need('salts.complete', missingSalts.length === 0, missingSalts.join(','));
    if (missingSalts.length) throw new UploadError('salts missing for some tasks', checks);
    const taskTree = buildTaskTree({
      environmentVersion,
      graderDigest,
      domain: TASK_DOMAIN,
      tasks: taskIds.map((id) => ({ taskId: id, taskHash: taskHashOfDir(path.join(payload, 'tasks', id)), salt: salts.tasks[id] as Hex })),
    });
    need('taskRoot', taskTree.root === manifest.taskRoot, taskTree.root);
    claim('taskRoot', taskTree.root);
    const auditRoot = (auditTaskIds.length
      ? buildTaskTree({
          environmentVersion,
          graderDigest,
          domain: AUDIT_DOMAIN,
          tasks: auditTaskIds.map((id) => ({ taskId: id, taskHash: taskHashOfDir(path.join(auditDir, id)), salt: salts.audit![id] as Hex })),
        }).root
      : `0x${'00'.repeat(32)}`) as Hex;
    need('auditRoot', auditRoot === manifest.auditRoot, auditRoot);
    claim('auditRoot', auditRoot);

    // ---------------------------------------------------------------- public docs
    const docs = (body.publicDocs ?? {}) as Record<string, DocValue>;
    const descBytes = docBytes(docs['description.json']);
    need('publicDocs.description.json', !!descBytes);
    if (!descBytes) throw new UploadError('publicDocs["description.json"] is required', checks);
    const descriptionHash = sha256Hex(descBytes);
    claim('descriptionHash', descriptionHash);
    try {
      const d = parseDescription(descBytes);
      need('description.schema', true);
      need('description.environmentVersion', d.environmentVersion === environmentVersion);
    } catch (e) {
      need('description.schema', false, errMsg(e).slice(0, 600));
    }
    const pubManifest = docBytes(docs['manifest.json']);
    if (pubManifest) need('publicDocs.manifest.matchesBundle', sha256Hex(pubManifest) === manifestHash);
    const md = docBytes(docs['description.md']);
    const lic = docBytes(docs.license ?? docs['license.json'] ?? docs['LICENSE.md'] ?? docs.LICENSE);
    const licenseHash = lic ? sha256Hex(lic) : null;
    claim('licenseHash', licenseHash);
    const requirementsLock = fs.readFileSync(path.join(payload, 'requirements.lock'), 'utf8');

    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new UploadError(`upload rejected: ${failed.map((c) => c.name).join(', ')}`, checks);

    // ---------------------------------------------------------------- preflight (sandbox)
    const dep = await prepareVenv(ctx.sandbox, ctx.cacheRoot, requirementsLock);
    let preflight: PreflightResult = {
      ok: false,
      buildOk: false,
      dependencies: { ok: dep.ok, venv: path.basename(dep.venv), log: dep.log.slice(-2000) },
      imports: null,
      purchased: [],
      audit: [],
      sandbox: ctx.sandbox.description,
      ranAt: new Date().toISOString(),
    };
    if (dep.ok) {
      const solutions = fs.existsSync(path.join(payload, 'solutions')) ? path.join(payload, 'solutions') : null;
      const p = await runTaskChecks(ctx, dep.venv, payload, [path.join(payload, 'tasks')], taskIds, solutions);
      const a = auditTaskIds.length ? await runTaskChecks(ctx, dep.venv, payload, [auditDir], auditTaskIds, null) : { output: { python: '', imports: { ok: true }, tasks: [] } as TaskCheckOutput, raw: '', error: null };
      preflight = {
        ...preflight,
        imports: p.output?.imports ?? { ok: false, error: p.error ?? 'no output' },
        purchased: p.output ? summarizeRows(p.output.tasks) : [],
        audit: a.output ? summarizeRows(a.output.tasks) : [],
      };
      const rows = [...preflight.purchased, ...preflight.audit];
      preflight.buildOk =
        !!p.output?.imports.ok && rows.length === taskIds.length + auditTaskIds.length && rows.every((r) => !r.error && (r.hiddenTestCount ?? 0) > 0);
      preflight.ok = preflight.buildOk && rows.every((r) => r.referenceSolutionPasses !== false);
      if (p.error) preflight.imports = { ok: false, error: p.error };
    }
    need('preflight.dependencies', preflight.dependencies.ok);
    need('preflight.graderImports', !!preflight.imports?.ok, preflight.imports?.error);
    need('preflight.hiddenTestsCollect', [...preflight.purchased, ...preflight.audit].every((r) => (r.hiddenTestCount ?? 0) > 0));

    // size of the validator input (for preview quotes; docs/PREVIEW_COST.md validatorInputChars)
    const validatorInputChars = buildValidatorInput({
      files: collectFiles(payload).filter((f) => !f.path.startsWith('solutions/')),
      descriptionJson: new TextDecoder().decode(descBytes),
      preflight: { dependencies: preflight.dependencies.ok, graderImports: preflight.imports?.ok, purchased: preflight.purchased, auditTaskCount: auditTaskIds.length, sandbox: preflight.sandbox },
    }).length;

    // ---------------------------------------------------------------- store
    const uploadId = ciphertextHash;
    ctx.blobs.put(encBundle);
    ctx.priv.putBytes('audit-ct', uploadId.slice(2), encAudit);
    ctx.blobs.put(descBytes);
    ctx.blobs.put(manifestText);
    const descriptionMdHash = md ? ctx.blobs.put(md) : null;
    if (lic) ctx.blobs.put(lic);
    const record: UploadRecord = {
      uploadId,
      environmentVersion,
      bundleHash,
      ciphertextHash,
      auditCiphertextHash,
      manifestHash,
      descriptionHash,
      descriptionMdHash,
      licenseHash,
      taskRoot: taskTree.root,
      auditRoot,
      taskIds,
      auditTaskIds,
      imageDigest: manifest.imageDigest as Hex,
      imageRef: String(manifest.imageRef),
      graderDigest,
      bundleDigest,
      requirementsLock,
      validatorInputChars,
      bundleKey: bytesToHex(bundleKey),
      auditKey: bytesToHex(auditKey),
      salts,
      preflight,
      checks,
      createdAt: new Date().toISOString(),
    };
    ctx.priv.put('uploads', uploadId.slice(2), record);
    ctx.priv.appendLog('uploads', { uploadId, bundleHash, preflightOk: preflight.ok });
    logger.info('upload accepted', { uploadId, bundleHash, preflightOk: preflight.ok });
    return {
      record,
      response: {
        uploadId,
        stored: {
          ciphertextHash,
          bundleHash,
          manifestHash,
          descriptionHash,
          descriptionMdHash,
          licenseHash,
          taskRoot: taskTree.root,
          auditRoot,
          taskCount: taskIds.length,
          auditTaskCount: auditTaskIds.length,
          imageDigest: manifest.imageDigest,
          ciphertextUrl: `${ctx.cfg.publicUrl}/blobs/${ciphertextHash.slice(2)}`,
          blobBaseUrl: `${ctx.cfg.publicUrl}/blobs/`,
        },
        checks,
        preflight: { ...preflight, dependencies: { ok: preflight.dependencies.ok } },
      },
    };
  } finally {
    fs.rmSync(payload, { recursive: true, force: true });
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
}

export function loadUpload(ctx: Ctx, ciphertextHash: Hex): UploadRecord | null {
  return ctx.priv.get<UploadRecord>('uploads', ciphertextHash.toLowerCase().slice(2));
}

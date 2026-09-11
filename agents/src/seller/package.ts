/**
 * Seller packaging: build the canonical purchased payload from a seller workspace, commit to it,
 * and encrypt it (BUILD_SPEC "Commitments and file formats").
 *
 * Workspace layout (seller-workspace/py-repair-kit):
 *   src/  tasks/<taskId>/{task.json,overlay/,visible_tests/,tests/}  grader/  solutions/
 *   requirements.lock  IMAGE_DIGEST  (+ optional Dockerfile.runner, scripts/, LICENSE-ENV.md, provenance.json)
 *   audit-tasks/<taskId>/   (separately encrypted, never in the purchased payload)
 *   listing/description.json (+ description.md)   listing/manifest.template.json
 *   SEEDED_DISPUTE.md (seller-private notes; never packaged)
 *
 * Output (agents/.data/seller/<environmentVersion>/, private, gitignored):
 *   payload/            plaintext staging of the purchased payload (manifest.json included)
 *   bundle.tar          canonical ustar of payload/   → bundleHash
 *   bundle.enc          EMENC1(K_bundle, bundle.tar)  → ciphertextHash
 *   audit.enc           EMENC1(K_audit, canonical tar of audit-tasks/)
 *   private/keys.json   K_bundle, K_audit              (never published)
 *   private/salts.json  per-task salts (tasks + audit) (never published or delivered)
 *   public/             description.json (exact seller bytes), description.md, manifest.json, license file
 *   listing-input.json  VersionInput for createListing + file map
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hex } from 'viem';
import { z } from 'zod';
import { parseImageDigest } from '../common/image.ts';
import { fillManifestTemplate } from './manifest-fill.ts';
import {
  AUDIT_DOMAIN,
  DEFAULT_EXCLUDE_NAMES,
  TASK_DOMAIN,
  assertTaskId,
  buildTaskTree,
  bundleDigestOfDir,
  bytesToHex,
  canonicalJson,
  canonicalTarOfDir,
  descriptionSchema,
  encryptFile,
  graderDigestOfDir,
  randomKey,
  randomSalt,
  saltsFileSchema,
  serializeManifest,
  sha256Hex,
  taskHashOfDir,
  type Manifest,
  type SaltsFile,
} from '@envmarket/shared';

/** What goes into the purchased payload (top-level names). `required` entries must exist. */
export const PAYLOAD_ENTRIES: ReadonlyArray<{ name: string; required: boolean }> = [
  { name: 'src', required: true },
  { name: 'tasks', required: true },
  { name: 'grader', required: true },
  { name: 'solutions', required: false },
  { name: 'requirements.lock', required: true },
  { name: 'IMAGE_DIGEST', required: true },
  // Extras the listing may promise as part of delivery (runner image recipe, verification scripts, license, provenance).
  { name: 'Dockerfile.runner', required: false },
  { name: '.dockerignore', required: false },
  { name: 'scripts', required: false },
  { name: 'LICENSE-ENV.md', required: false },
  { name: 'provenance.json', required: false },
  { name: 'README.md', required: false },
  { name: 'listing', required: false },
];

/** Never packaged, anywhere in the tree. */
export const NEVER_PACKAGE = new Set<string>([...DEFAULT_EXCLUDE_NAMES, 'SEEDED_DISPUTE.md', 'audit-tasks', 'salts.json', 'keys.json']);

/**
 * Minimal description shape the market relies on (numbered claims + environmentVersion). The
 * shared strict schema is tried first; sellers may add fields (e.g. per-claim `check` hints).
 */
export const looseDescriptionSchema = z.looseObject({
  environmentVersion: z.string().min(1),
  title: z.string().min(1),
  claims: z
    .array(z.looseObject({ id: z.string().regex(/^C[1-9][0-9]*$/), text: z.string().min(1).max(2000), category: z.string().optional() }))
    .min(1),
});
export type LooseDescription = z.infer<typeof looseDescriptionSchema>;

export function parseDescriptionLoose(text: string): { description: LooseDescription; strict: boolean } {
  const json = JSON.parse(text);
  const strict = descriptionSchema.safeParse(json).success;
  const description = looseDescriptionSchema.parse(json);
  const ids = new Set<string>();
  for (const c of description.claims) {
    if (ids.has(c.id)) throw new Error(`duplicate claim id ${c.id}`);
    ids.add(c.id);
  }
  return { description, strict };
}

export interface PackageOptions {
  workspace: string;
  outDir: string;
  /** Base units. Defaults to the manifest template's commercialTerms. */
  price?: bigint;
  collateral?: bigint;
  deliveryWindowSec?: number;
  challengeWindowSec?: number;
  currency?: string;
  decimals?: number;
  /** Fixed salts (tests / reproducible rebuilds). Fresh random salts otherwise. */
  salts?: { tasks: Record<string, Hex>; audit: Record<string, Hex> };
  /** Fixed keys (tests only). Fresh random keys otherwise. */
  bundleKey?: Uint8Array;
  auditKey?: Uint8Array;
  /** Replace an existing output directory. */
  force?: boolean;
}

export interface VersionInputJson {
  bundleHash: Hex;
  ciphertextHash: Hex;
  imageDigest: Hex;
  descriptionHash: Hex;
  manifestHash: Hex;
  licenseHash: Hex;
  taskRoot: Hex;
  auditRoot: Hex;
  taskCount: number;
  auditTaskCount: number;
  price: string;
  collateral: string;
  deliveryWindow: number;
  challengeWindow: number;
  uri: string | null;
}

export interface ListingInput {
  schemaVersion: '1';
  environmentVersion: string;
  name: string;
  versionInput: VersionInputJson;
  auditCiphertextHash: Hex;
  bundleDigest: Hex;
  graderDigest: Hex;
  imageRef: string;
  taskIds: string[];
  auditTaskIds: string[];
  descriptionStrictSchema: boolean;
  files: {
    bundleCiphertext: string;
    auditCiphertext: string;
    description: string;
    descriptionMd: string | null;
    manifest: string;
    license: string;
  };
  createdAt: string;
}

export interface PackageResult {
  outDir: string;
  listing: ListingInput;
  bundleHash: Hex;
  manifest: Manifest;
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NEVER_PACKAGE.has(d.name))
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const p = path.join(root, c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

export { parseImageDigest };

const copyFilter = (src: string) => !NEVER_PACKAGE.has(path.basename(src));

/** Build, commit and encrypt a version. Pure function of (workspace, options, salts, keys, nonces). */
export function packageEnvironment(opts: PackageOptions): PackageResult {
  const ws = path.resolve(opts.workspace);
  const out = path.resolve(opts.outDir);
  if (fs.existsSync(out)) {
    if (!opts.force) throw new Error(`${out} exists; pass --force to rebuild (a listed version must not be overwritten)`);
    fs.rmSync(out, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- listing docs
  const descFile = firstExisting(ws, ['listing/description.json', 'description.json']);
  if (!descFile) throw new Error(`no listing/description.json in ${ws}`);
  const descriptionBytes = new Uint8Array(fs.readFileSync(descFile));
  const { description, strict: descriptionStrictSchema } = parseDescriptionLoose(Buffer.from(descriptionBytes).toString('utf8'));
  const environmentVersion = description.environmentVersion;
  const descMdFile = firstExisting(ws, ['listing/description.md', 'description.md']);
  const templateFile = firstExisting(ws, ['listing/manifest.template.json', 'manifest.template.json', 'listing/manifest.json']);
  if (!templateFile) throw new Error(`no listing/manifest.template.json in ${ws}`);
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf8')) as Record<string, any>;
  if (template.environmentVersion && template.environmentVersion !== environmentVersion) {
    throw new Error(`manifest template environmentVersion ${template.environmentVersion} != description ${environmentVersion}`);
  }

  // ---------------------------------------------------------------- stage payload
  const payload = path.join(out, 'payload');
  fs.mkdirSync(payload, { recursive: true, mode: 0o700 });
  for (const e of PAYLOAD_ENTRIES) {
    const src = path.join(ws, e.name);
    if (!fs.existsSync(src)) {
      if (e.required) throw new Error(`workspace is missing required payload entry ${e.name}`);
      continue;
    }
    fs.cpSync(src, path.join(payload, e.name), { recursive: true, filter: copyFilter });
  }

  const { ref: imageRef, digest: imageDigest } = parseImageDigest(fs.readFileSync(path.join(payload, 'IMAGE_DIGEST'), 'utf8'));
  const graderDigest = graderDigestOfDir(path.join(payload, 'grader'));

  // ---------------------------------------------------------------- commitments
  const taskIds = listDirs(path.join(payload, 'tasks'));
  const auditDir = path.join(ws, 'audit-tasks');
  const auditTaskIds = listDirs(auditDir);
  if (taskIds.length === 0) throw new Error('no tasks');
  taskIds.forEach(assertTaskId);
  auditTaskIds.forEach(assertTaskId);
  for (const a of auditTaskIds) if (taskIds.includes(a)) throw new Error(`task id ${a} is both purchased and audit`);

  const salts: SaltsFile = saltsFileSchema.parse({
    schemaVersion: '1',
    environmentVersion,
    tasks: Object.fromEntries(taskIds.map((id) => [id, (opts.salts?.tasks[id] ?? randomSalt()).toLowerCase()])),
    audit: Object.fromEntries(auditTaskIds.map((id) => [id, (opts.salts?.audit[id] ?? randomSalt()).toLowerCase()])),
  });

  const taskTree = buildTaskTree({
    environmentVersion,
    graderDigest,
    domain: TASK_DOMAIN,
    tasks: taskIds.map((id) => ({ taskId: id, taskHash: taskHashOfDir(path.join(payload, 'tasks', id)), salt: salts.tasks[id] as Hex })),
  });
  const auditTree =
    auditTaskIds.length > 0
      ? buildTaskTree({
          environmentVersion,
          graderDigest,
          domain: AUDIT_DOMAIN,
          tasks: auditTaskIds.map((id) => ({ taskId: id, taskHash: taskHashOfDir(path.join(auditDir, id)), salt: salts.audit![id] as Hex })),
        })
      : null;
  const auditRoot = (auditTree?.root ?? `0x${'00'.repeat(32)}`) as Hex;

  // ---------------------------------------------------------------- license / provenance (hashed into the manifest)
  const licenseFile = firstExisting(ws, ['LICENSE-ENV.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'listing/LICENSE', 'listing/LICENSE.md', 'listing/license.md']);
  const licenseFileBytes = licenseFile ? new Uint8Array(fs.readFileSync(licenseFile)) : null;
  const provenanceFile = firstExisting(ws, ['provenance.json', 'listing/provenance.json']);
  const provenanceBytes = provenanceFile ? new Uint8Array(fs.readFileSync(provenanceFile)) : null;

  // ---------------------------------------------------------------- manifest
  const bundleDigest = bundleDigestOfDir(payload);
  const manifest = fillManifestTemplate(template, {
    environmentVersion,
    bundleDigest,
    imageDigest,
    imageRef,
    taskRoot: taskTree.root,
    taskIds,
    auditRoot,
    auditTaskCount: auditTaskIds.length,
    graderDigest,
    licenseSha256: licenseFileBytes ? sha256Hex(licenseFileBytes) : null,
    provenanceSha256: provenanceBytes ? sha256Hex(provenanceBytes) : null,
    provenance: provenanceBytes ? JSON.parse(Buffer.from(provenanceBytes).toString('utf8')) : null,
    commercial: {
      price: opts.price?.toString(),
      collateral: opts.collateral?.toString(),
      currency: opts.currency ?? (template.commercialTerms?.currency as string | undefined) ?? 'tUSDC',
      decimals: opts.decimals ?? (template.commercialTerms?.decimals as number | undefined) ?? 6,
      deliveryWindowSec: opts.deliveryWindowSec,
      challengeWindowSec: opts.challengeWindowSec,
    },
  });
  const manifestText = serializeManifest(manifest);
  fs.writeFileSync(path.join(payload, 'manifest.json'), manifestText);
  const manifestHash = sha256Hex(manifestText);

  // ---------------------------------------------------------------- bundle + encryption
  const bundle = canonicalTarOfDir(payload);
  const bundleHash = sha256Hex(bundle);
  for (const forbidden of ['audit-tasks', 'SEEDED_DISPUTE.md']) {
    if (fs.existsSync(path.join(payload, forbidden))) throw new Error(`internal: ${forbidden} leaked into payload`);
  }
  const bundleKey = opts.bundleKey ?? randomKey();
  const auditKey = opts.auditKey ?? randomKey();
  if (Buffer.from(bundleKey).equals(Buffer.from(auditKey))) throw new Error('K_bundle and K_audit must differ');
  const bundleEnc = encryptFile(bundleKey, bundle);
  const ciphertextHash = sha256Hex(bundleEnc);
  const auditTar = auditTaskIds.length > 0 ? canonicalTarOfDir(auditDir) : new Uint8Array(1024);
  const auditEnc = encryptFile(auditKey, auditTar);
  const auditCiphertextHash = sha256Hex(auditEnc);

  // ---------------------------------------------------------------- public docs
  const pub = path.join(out, 'public');
  fs.mkdirSync(pub, { recursive: true });
  // descriptionHash commits to the seller's exact description.json bytes (the frozen dispute basis).
  fs.writeFileSync(path.join(pub, 'description.json'), descriptionBytes);
  const descriptionHash = sha256Hex(descriptionBytes);
  let descriptionMd: string | null = null;
  if (descMdFile) {
    descriptionMd = 'public/description.md';
    fs.copyFileSync(descMdFile, path.join(out, descriptionMd));
  }
  fs.writeFileSync(path.join(pub, 'manifest.json'), manifestText);
  let licensePath: string;
  let licenseBytes: Uint8Array;
  if (licenseFile && licenseFileBytes) {
    licenseBytes = licenseFileBytes;
    licensePath = `public/${path.basename(licenseFile)}`;
  } else {
    licenseBytes = new TextEncoder().encode(canonicalJson(manifest.license));
    licensePath = 'public/license.json';
  }
  fs.writeFileSync(path.join(out, licensePath), licenseBytes);
  const licenseHash = sha256Hex(licenseBytes);

  // ---------------------------------------------------------------- write outputs
  fs.writeFileSync(path.join(out, 'bundle.tar'), bundle, { mode: 0o600 });
  fs.writeFileSync(path.join(out, 'bundle.enc'), bundleEnc);
  fs.writeFileSync(path.join(out, 'audit.enc'), auditEnc);
  const priv = path.join(out, 'private');
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(priv, 'keys.json'),
    JSON.stringify({ bundleKey: bytesToHex(bundleKey), auditKey: bytesToHex(auditKey) }, null, 2) + '\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(priv, 'salts.json'), JSON.stringify(salts, null, 2) + '\n', { mode: 0o600 });

  const listing: ListingInput = {
    schemaVersion: '1',
    environmentVersion,
    name: String(manifest.name),
    versionInput: {
      bundleHash,
      ciphertextHash,
      imageDigest,
      descriptionHash,
      manifestHash,
      licenseHash,
      taskRoot: taskTree.root,
      auditRoot,
      taskCount: taskIds.length,
      auditTaskCount: auditTaskIds.length,
      price: String(manifest.commercialTerms.price),
      collateral: String(manifest.commercialTerms.collateral),
      deliveryWindow: manifest.commercialTerms.deliveryWindowSec,
      challengeWindow: manifest.commercialTerms.challengeWindowSec,
      uri: null,
    },
    auditCiphertextHash,
    bundleDigest,
    graderDigest,
    imageRef,
    taskIds,
    auditTaskIds,
    descriptionStrictSchema,
    files: {
      bundleCiphertext: 'bundle.enc',
      auditCiphertext: 'audit.enc',
      description: 'public/description.json',
      descriptionMd,
      manifest: 'public/manifest.json',
      license: licensePath,
    },
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out, 'listing-input.json'), JSON.stringify(listing, null, 2) + '\n');
  return { outDir: out, listing, bundleHash, manifest };
}

export function readListingInput(dir: string): ListingInput {
  return JSON.parse(fs.readFileSync(path.join(dir, 'listing-input.json'), 'utf8')) as ListingInput;
}

export function writeListingInput(dir: string, l: ListingInput): void {
  fs.writeFileSync(path.join(dir, 'listing-input.json'), JSON.stringify(l, null, 2) + '\n');
}

export function readKeys(dir: string): { bundleKey: Hex; auditKey: Hex } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'private', 'keys.json'), 'utf8'));
}

export function readSalts(dir: string): SaltsFile {
  return saltsFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'private', 'salts.json'), 'utf8')));
}

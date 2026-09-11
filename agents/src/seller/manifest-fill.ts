/**
 * Fill a seller's manifest template into a manifest that satisfies @envmarket/shared's
 * manifestSchema, without discarding the seller's richer fields.
 *
 * - Computed commitments are always set: bundleDigest, imageDigest, imageRef, taskRoot,
 *   taskCount, taskIds (taskMask bit i = taskIds[i]), auditRoot, auditTaskCount, grader.digest,
 *   license.sha256, provenance.sha256, commercialTerms.{price,collateral,currency,decimals,...}.
 * - Where the template uses a different shape for a required field (e.g. entrypoints as argv
 *   objects, memoryMB instead of memoryMb), the schema field is derived from it and the seller's
 *   original value is preserved next to it (sub-objects are loose).
 * - Any remaining "<FILL..." placeholder is an error: nothing unfilled is ever committed.
 */
import type { Hex } from 'viem';
import { parseManifest, type Manifest } from '@envmarket/shared';

export interface ComputedFields {
  environmentVersion: string;
  bundleDigest: Hex;
  imageDigest: Hex;
  imageRef: string;
  taskRoot: Hex;
  taskIds: string[];
  auditRoot: Hex;
  auditTaskCount: number;
  graderDigest: Hex;
  licenseSha256: Hex | null;
  provenanceSha256: Hex | null;
  provenance: Record<string, any> | null;
  commercial: {
    price?: string;
    collateral?: string;
    currency?: string;
    decimals?: number;
    deliveryWindowSec?: number;
    challengeWindowSec?: number;
  };
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isPlaceholder = (x: unknown) => typeof x === 'string' && x.trim().startsWith('<FILL');
const pos = (x: unknown): number | undefined => (typeof x === 'number' && x > 0 ? x : undefined);

function argvString(x: unknown): string | undefined {
  if (typeof x === 'string' && x.length > 0 && !isPlaceholder(x)) return x;
  if (isObj(x) && Array.isArray(x.argv)) return x.argv.map(String).join(' ');
  return undefined;
}

export function findPlaceholders(v: unknown, p = '$'): string[] {
  if (isPlaceholder(v)) return [p];
  if (Array.isArray(v)) return v.flatMap((x, i) => findPlaceholders(x, `${p}[${i}]`));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => findPlaceholders(x, `${p}.${k}`));
  return [];
}

/** Market default reference-protocol decoding budget (TEE MAX_TOKENS default). */
export const DEFAULT_MAX_TOKENS = 4096;

export function fillManifestTemplate(template: Record<string, any>, c: ComputedFields): Manifest {
  const t: Record<string, any> = structuredClone(template);
  if (Array.isArray(t.taskIds) && t.taskIds.join(',') !== c.taskIds.join(',')) {
    throw new Error(`manifest template taskIds [${t.taskIds}] != tasks/ directories [${c.taskIds}]`);
  }

  // ---- identity + commitments
  t.schemaVersion = '1';
  t.name = typeof t.name === 'string' && t.name ? t.name : (t.environmentId ?? c.environmentVersion.split('@')[0]);
  t.environmentVersion = c.environmentVersion;
  t.bundleDigest = c.bundleDigest;
  t.imageDigest = c.imageDigest;
  t.imageRef = c.imageRef;
  if (isObj(t.image) && isPlaceholder(t.image.archive)) t.image.archive = null;
  t.taskRoot = c.taskRoot;
  t.taskCount = c.taskIds.length;
  t.taskIds = [...c.taskIds];
  t.taskMaskOrder ??= 'bit i of an on-chain taskMask refers to taskIds[i]';
  t.auditRoot = c.auditRoot;
  t.auditTaskCount = c.auditTaskCount;

  // ---- entrypoints: schema wants strings; keep argv specs
  const ep = isObj(t.entrypoints) ? t.entrypoints : {};
  const spec = structuredClone(ep);
  const out: Record<string, any> = {};
  for (const k of ['reset', 'step', 'grade', 'close']) {
    const s = argvString(ep[k]);
    if (!s) throw new Error(`manifest template entrypoints.${k} missing`);
    out[k] = s;
  }
  t.entrypoints = { ...out, spec };

  // ---- schemas: observation/action/gradeResult
  const sc = isObj(t.schemas) ? t.schemas : {};
  if (sc.observation === undefined) {
    const obs = Object.fromEntries(Object.entries(sc).filter(([k]) => k.startsWith('observation.')).map(([k, v]) => [k.slice('observation.'.length), v]));
    if (Object.keys(obs).length > 0) sc.observation = obs;
  }
  t.schemas = sc;

  // ---- grader
  const g = isObj(t.grader) ? t.grader : {};
  if (typeof g.dependencies === 'string') {
    g.dependenciesNote = g.dependencies;
    g.dependencies = ['requirements.lock'];
  }
  g.dependencies ??= [];
  g.externalJudge ??= null;
  g.digest = c.graderDigest;
  t.grader = g;

  // ---- resources
  const r = isObj(t.resources) ? t.resources : {};
  r.memoryMb ??= pos(r.memoryMB);
  r.diskMb ??= pos(r.diskMB);
  r.episodeTimeoutSec ??= pos(r.episodeDurationSec);
  if (typeof r.concurrency !== 'number') {
    if (r.concurrency !== undefined) r.concurrencyNote = r.concurrency;
    r.concurrency = 1; // per-container episode concurrency; see concurrencyNote for the seller's statement
  }
  t.resources = r;

  // ---- determinism
  const d = isObj(t.determinism) ? t.determinism : {};
  d.supportedRuntimes ??= d.supportedRuntime ? [String(d.supportedRuntime)] : undefined;
  d.resultsMayVary ??= typeof d.resultsVary === 'boolean' ? d.resultsVary : undefined;
  t.determinism = d;

  // ---- reference protocol (the market's TEE harness; its digests are bound in the signed report)
  const rp = isObj(t.referenceProtocol) ? t.referenceProtocol : {};
  rp.id ??= `${c.environmentVersion}/reference-protocol-v1`;
  if (Array.isArray(rp.models)) rp.models = rp.models.map((m: unknown) => (typeof m === 'string' ? { requested: m, artifact: null } : m));
  if (isPlaceholder(rp.harness) || rp.harness === undefined) rp.harness = 'EnvMarket TEE reference harness (harnessDigest recorded in the signed preview report)';
  if (isPlaceholder(rp.prompt)) delete rp.prompt; // promptDigest is recorded in the signed report
  if (isObj(rp.decoding) && (isPlaceholder(rp.decoding.maxTokens) || rp.decoding.maxTokens === undefined)) rp.decoding.maxTokens = DEFAULT_MAX_TOKENS;
  t.referenceProtocol = rp;

  // ---- license
  const l = isObj(t.license) ? t.license : {};
  if (c.licenseSha256) l.sha256 = c.licenseSha256;
  else if (isPlaceholder(l.sha256)) delete l.sha256;
  l.summary ??= 'Non-exclusive internal training and evaluation; redistribution requires separate written permission' + (l.file ? ` (${l.file})` : '');
  l.exclusive ??= false;
  l.redistribution ??= false;
  t.license = l;

  // ---- provenance
  const p = isObj(t.provenance) ? t.provenance : {};
  if (c.provenanceSha256) p.sha256 = c.provenanceSha256;
  else if (isPlaceholder(p.sha256)) delete p.sha256;
  const pj = c.provenance ?? {};
  p.authors ??= pj.authoredBy ? [String(pj.authoredBy)] : undefined;
  p.upstreamSources ??= Array.isArray(pj.upstreamSources) ? pj.upstreamSources : [];
  p.funders ??= Array.isArray(pj.funders) ? pj.funders : [];
  t.provenance = p;

  // ---- conflicts
  const cf = isObj(t.conflicts) ? t.conflicts : {};
  cf.relatedParties ??= [];
  cf.disclosures ??= typeof cf.notes === 'string' ? [cf.notes] : [];
  t.conflicts = cf;

  // ---- commercial terms
  const ct = isObj(t.commercialTerms) ? t.commercialTerms : {};
  for (const [k, v] of Object.entries(c.commercial)) if (v !== undefined) ct[k] = v;
  if (typeof ct.perTaskAllocation !== 'string' && !Array.isArray(ct.perTaskAllocation)) {
    if (ct.perItemAllocation !== undefined) ct.perItemAllocationNote = ct.perItemAllocation;
    ct.perTaskAllocation = 'equal';
  }
  delete ct.perItemAllocation;
  t.commercialTerms = ct;

  const left = findPlaceholders(t);
  if (left.length > 0) throw new Error(`manifest still has unfilled placeholders: ${left.join(', ')}`);
  return parseManifest(t);
}

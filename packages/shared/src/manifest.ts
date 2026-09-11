/**
 * manifest.json (schemaVersion "1") — fields per RL_ENV_MARKET.md "The environment interface",
 * plus `name`, `environmentVersion` (used in task leaves) and `imageRef` (immutable image reference).
 * Sub-objects are "loose" (unknown keys are preserved) so adapters can extend them.
 *
 * bundleDigest = sha256(canonical tar of the payload WITHOUT manifest.json).
 * manifestHash = sha256(exact manifest.json bytes). Write it with `serializeManifest` (canonical JSON).
 */
import type { Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, fromUtf8, sha256Hex } from './hash.ts';
import { canonicalTarOfDir, type DirTarOptions } from './tar.ts';
import { zBytes32, zNonNegInt, zPosInt, zUintString } from './schemas.ts';

export const ENVIRONMENT_TYPES = ['coding', 'browser', 'tool-use', 'math', 'other'] as const;
export const NETWORK_MODES = ['offline', 'recorded-fixtures', 'external'] as const;

const zSchemaDoc = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const manifestSchema = z.looseObject({
  schemaVersion: z.literal('1'),
  environmentType: z.enum(ENVIRONMENT_TYPES),
  name: z.string().min(1),
  environmentVersion: z.string().min(1),

  bundleDigest: zBytes32,
  imageDigest: zBytes32,
  imageRef: z.string().min(1), // e.g. "python:3.12-slim@sha256:<64hex>"

  taskRoot: zBytes32,
  taskCount: z.number().int().min(1).max(256),
  auditRoot: zBytes32,
  auditTaskCount: zNonNegInt,

  entrypoints: z.looseObject({
    reset: z.string().min(1), // reset(taskId, seed)
    step: z.string().min(1), // step(action)
    grade: z.string().min(1), // grade(trajectoryOrArtifact)
    close: z.string().min(1), // close()
  }),
  schemas: z.looseObject({
    observation: zSchemaDoc,
    action: zSchemaDoc,
    gradeResult: zSchemaDoc, // score, success, termination, private diagnostics
  }),
  grader: z.looseObject({
    entrypoint: z.string().min(1),
    dependencies: z.array(z.string()),
    version: z.string().min(1),
    digest: zBytes32, // graderDigest used in task leaves
    externalJudge: z.string().nullable(),
  }),
  resources: z.looseObject({
    cpu: z.number().positive(),
    memoryMb: zPosInt,
    accelerator: z.string().nullable(),
    diskMb: zPosInt,
    episodeTimeoutSec: zPosInt,
    actionBudget: zPosInt,
    concurrency: zPosInt,
  }),
  determinism: z.looseObject({
    randomnessSources: z.array(z.string()),
    seedPolicy: z.string().min(1),
    supportedRuntimes: z.array(z.string()).min(1),
    resultsMayVary: z.boolean(),
  }),
  networkPolicy: z.looseObject({
    mode: z.enum(NETWORK_MODES),
    externalDependencies: z.array(z.string()),
  }),
  referenceProtocol: z.looseObject({
    id: z.string().min(1),
    models: z.array(z.looseObject({ requested: z.string().min(1), artifact: z.string().nullable() })).min(1),
    harness: z.string().min(1),
    harnessDigest: zBytes32.optional(),
    promptDigest: zBytes32.optional(),
    decoding: z.looseObject({ temperature: z.number().min(0), seed: z.number().int(), maxTokens: zPosInt }),
    taskSelection: z.string().min(1),
    actionBudget: zPosInt,
    timeBudgetSec: zPosInt,
    successRule: z.string().min(1),
  }),
  license: z.looseObject({
    id: z.string().min(1),
    summary: z.string().min(1),
    exclusive: z.boolean(),
    redistribution: z.boolean(),
  }),
  provenance: z.looseObject({
    authors: z.array(z.string()).min(1),
    upstreamSources: z.array(z.looseObject({ name: z.string().min(1), license: z.string().min(1), url: z.string().optional() })),
    funders: z.array(z.string()),
  }),
  conflicts: z.looseObject({
    relatedParties: z.array(z.string()),
    disclosures: z.array(z.string()),
  }),
  commercialTerms: z.looseObject({
    currency: z.string().min(1), // "tUSDC"
    decimals: z.number().int().min(0).max(36),
    price: zUintString, // base units
    perTaskAllocation: z.union([z.literal('equal'), z.array(zUintString)]),
    deliveryWindowSec: zPosInt,
    challengeWindowSec: zPosInt,
    refundCapBps: z.number().int().min(0).max(10000),
    collateral: zUintString, // base units
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;

export function parseManifest(input: unknown): Manifest {
  const v = typeof input === 'string' || input instanceof Uint8Array ? JSON.parse(typeof input === 'string' ? input : fromUtf8(input)) : input;
  return manifestSchema.parse(v);
}

/** Canonical JSON text to write as manifest.json. */
export function serializeManifest(m: Manifest): string {
  return canonicalJson(manifestSchema.parse(m));
}

/** manifestHash over exact bytes (or canonical JSON of an object). */
export function manifestHash(m: Manifest | string | Uint8Array): Hex {
  return typeof m === 'string' || m instanceof Uint8Array ? sha256Hex(m) : sha256Hex(serializeManifest(m));
}

/** bundleDigest: sha256 of the canonical tar of the payload dir excluding manifest.json. */
export function bundleDigestOfDir(payloadDir: string, opts: DirTarOptions = {}): Hex {
  const extra = opts.exclude;
  const exclude =
    typeof extra === 'function'
      ? (rel: string, isDir: boolean) => rel === 'manifest.json' || extra(rel, isDir)
      : ['manifest.json', ...(extra ?? [])];
  return sha256Hex(canonicalTarOfDir(payloadDir, { ...opts, exclude }));
}

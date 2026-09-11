/**
 * manifest.json (schemaVersion "1") — fields per RL_ENV_MARKET.md "The environment interface".
 *
 * Strict where other components depend on exact values (commitments, counts, digests);
 * loose elsewhere: the interface table names the fields but not their inner shape, so
 * sub-objects accept adapter-specific structure (unknown keys are preserved).
 *
 * Optional extras used by the demo: `environmentId`, `taskIds` (ASCII-sorted; bit i of an
 * on-chain taskMask = taskIds[i] = leaf index i), `image`, `grader.digest` (graderDigest in leaves).
 *
 * bundleDigest = sha256(canonical tar of the payload WITHOUT manifest.json).
 * manifestHash = sha256(exact manifest.json bytes). Write it with `serializeManifest` (canonical JSON).
 */
import type { Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, fromUtf8, sha256Hex } from './hash.ts';
import { canonicalTarOfDir, type DirTarOptions } from './tar.ts';
import { zBytes32, zNonNegInt, zUintString } from './schemas.ts';

export const ENVIRONMENT_TYPES = ['coding', 'browser', 'tool-use', 'math', 'other'] as const;
export const NETWORK_MODES = ['offline', 'recorded-fixtures', 'external'] as const;

const zEntrypoint = z.union([z.string().min(1), z.looseObject({})]);
const zDoc = z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);
const zStrings = z.union([z.string(), z.array(z.string())]);

export const manifestSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    environmentType: z.enum(ENVIRONMENT_TYPES),
    environmentId: z.string().min(1).optional(),
    environmentVersion: z.string().min(1),

    bundleDigest: zBytes32,
    imageDigest: zBytes32,

    taskRoot: zBytes32,
    taskCount: z.number().int().min(1).max(256),
    taskIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)).optional(),
    auditRoot: zBytes32,
    auditTaskCount: zNonNegInt,

    entrypoints: z.looseObject({ reset: zEntrypoint, step: zEntrypoint, grade: zEntrypoint, close: zEntrypoint }),
    schemas: z.record(z.string(), zDoc),
    grader: z.looseObject({
      entrypoint: z.string().min(1),
      version: z.string().min(1),
      dependencies: zStrings,
      digest: zBytes32.optional(),
      externalJudge: z.string().nullable(),
    }),
    resources: z.looseObject({ cpu: z.number().positive(), accelerator: z.string().nullable() }),
    determinism: z.looseObject({ randomnessSources: z.array(z.string()), seedPolicy: z.string().min(1) }),
    networkPolicy: z.looseObject({ mode: z.enum(NETWORK_MODES) }),
    referenceProtocol: z.looseObject({
      models: z.array(z.union([z.string().min(1), z.looseObject({ requested: z.string().min(1) })])).min(1),
      decoding: z.looseObject({ temperature: z.number().min(0), seed: z.number().int() }),
      taskSelection: z.string().min(1),
      actionBudget: z.number().int().positive(),
      timeBudgetSec: z.number().positive(),
      successRule: z.string().min(1),
    }),
    license: z.looseObject({ id: z.string().min(1) }),
    provenance: z.looseObject({}),
    conflicts: z.looseObject({ relatedParties: z.array(z.string()) }),
    commercialTerms: z.looseObject({
      price: zUintString, // base units (6 decimals)
      collateral: zUintString, // base units
      deliveryWindowSec: z.number().int().positive(),
      challengeWindowSec: z.number().int().positive(),
      refundCapBps: z.number().int().min(0).max(10000),
    }),
  })
  .superRefine((m, ctx) => {
    if (m.taskIds) {
      if (m.taskIds.length !== m.taskCount) ctx.addIssue({ code: 'custom', path: ['taskIds'], message: 'taskIds length != taskCount' });
      const sorted = [...m.taskIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (new Set(m.taskIds).size !== m.taskIds.length) ctx.addIssue({ code: 'custom', path: ['taskIds'], message: 'duplicate taskIds' });
      if (sorted.some((id, i) => id !== m.taskIds![i])) {
        ctx.addIssue({ code: 'custom', path: ['taskIds'], message: 'taskIds must be in ASCII order (leaf index = taskMask bit)' });
      }
    }
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

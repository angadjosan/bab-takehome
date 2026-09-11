/**
 * Preview report (report.json, canonical JSON; reportHash = sha256(canonical JSON bytes)).
 * Scores are rounded to 5 percentage points and stored as integer percents (0, 5, ..., 100)
 * to keep canonical JSON free of float noise. Timestamps are ISO-8601 UTC strings.
 */
import type { Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, fromUtf8, sha256Hex } from './hash.ts';
import { zAddress, zBytes32, zIsoDate, zNonNegInt, zUintString } from './schemas.ts';

export const REPORT_TYPE = 'envmarket.report.v1';
export const SUCCESS_RULE_ALL_TESTS = 'all hidden tests pass';
export const WITHHELD_EXPLANATION = 'Explanation withheld by output screening.';
export const EXPLANATION_MAX_WORDS = 120;
export const EXPLANATION_MAX_BYTES = 1000;
export const ATTESTATION_KINDS = ['eigencompute-tdx', 'none-local-dev'] as const;
export const JOB_STATUSES = ['scheduled', 'running', 'succeeded', 'failed', 'infra_failure', 'superseded', 'cancelled'] as const;

/** Round a pass rate in [0,1] to the nearest 5 percentage points (half up). Returns integer percent. */
export function roundPass1(x: number): number {
  if (!Number.isFinite(x) || x < 0 || x > 1) throw new RangeError(`pass rate must be in [0,1], got ${x}`);
  return Math.round(x * 20 + 1e-9) * 5;
}

/** Exact integer version: round(solved/attempted) to 5pp, half up. null when attempted = 0. */
export function pass1Rounded(solved: number, attempted: number): number | null {
  if (!Number.isInteger(solved) || !Number.isInteger(attempted) || solved < 0 || attempted < 0 || solved > attempted) {
    throw new RangeError(`bad counts solved=${solved} attempted=${attempted}`);
  }
  if (attempted === 0) return null;
  // nearest multiple of 5 of 100*s/a, half up: floor((20*s*2 + a) / (2a)) * 5
  return Math.floor((40 * solved + attempted) / (2 * attempted)) * 5;
}

export function explanationWithinLimits(text: string): boolean {
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  return words <= EXPLANATION_MAX_WORDS && new TextEncoder().encode(text).length <= EXPLANATION_MAX_BYTES;
}

const outcomeSchema = z
  .strictObject({
    attempted: zNonNegInt,
    solved: zNonNegInt,
    pass1Rounded: z.number().int().min(0).max(100).multipleOf(5).nullable(),
  })
  .refine((o) => o.solved <= o.attempted, 'solved > attempted')
  .refine((o) => o.pass1Rounded === pass1Rounded(o.solved, o.attempted), 'pass1Rounded inconsistent with counts');

export const reportModelSchema = z.strictObject({
  requested: z.string().min(1),
  resolved: z.string().min(1).nullable(),
  provider: z.string().min(1).nullable(),
  status: z.enum(['run', 'unavailable']),
  purchased: outcomeSchema,
  audit: outcomeSchema,
  infraFailures: zNonNegInt,
});

export const reportSchema = z.strictObject({
  type: z.literal(REPORT_TYPE),
  versionId: zUintString,
  environmentVersion: z.string().min(1),
  bundleHash: zBytes32,
  ciphertextHash: zBytes32,
  taskRoot: zBytes32,
  auditRoot: zBytes32,
  protocol: z.strictObject({
    id: z.string().min(1),
    harnessDigest: zBytes32,
    promptDigest: zBytes32,
    decoding: z.strictObject({ temperature: z.number().min(0), seed: z.number().int(), maxTokens: z.number().int().positive() }),
    actionBudget: z.number().int().positive(),
    timeBudgetSec: z.number().int().positive(),
    successRule: z.string().min(1),
  }),
  models: z.array(reportModelSchema).min(1),
  uncertainty: z.string().min(1),
  validator: z.strictObject({
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    promptHash: zBytes32,
    explanation: z.string().refine(explanationWithinLimits, `explanation exceeds ${EXPLANATION_MAX_WORDS} words / ${EXPLANATION_MAX_BYTES} bytes`),
    screening: z.strictObject({ passed: z.boolean(), reasons: z.array(z.string()) }),
  }),
  jobs: z.array(
    z.strictObject({
      jobId: z.string().min(1),
      startedAt: zIsoDate,
      finishedAt: zIsoDate.nullable(),
      status: z.enum(JOB_STATUSES),
    }),
  ),
  runtime: z.strictObject({ imageDigest: zBytes32, sandbox: z.string().min(1), network: z.literal('none') }),
  attestation: z.strictObject({
    kind: z.enum(ATTESTATION_KINDS),
    appId: z.string().nullable(),
    signer: zAddress,
    quoteDigest: z.string().nullable(),
    verifyUrl: z.string().nullable(),
  }),
  signer: zAddress,
  createdAt: zIsoDate,
});

export type Report = z.infer<typeof reportSchema>;
export type ReportModel = z.infer<typeof reportModelSchema>;

export function parseReport(input: unknown): Report {
  const v = typeof input === 'string' || input instanceof Uint8Array ? JSON.parse(typeof input === 'string' ? input : fromUtf8(input)) : input;
  return reportSchema.parse(v);
}

/** Canonical report JSON (validates first). */
export function serializeReport(r: Report): string {
  return canonicalJson(reportSchema.parse(r));
}

/** reportHash = sha256(canonical JSON). Strings/bytes are hashed as-is. */
export function reportHash(r: Report | string | Uint8Array): Hex {
  return typeof r === 'string' || r instanceof Uint8Array ? sha256Hex(r) : sha256Hex(serializeReport(r));
}

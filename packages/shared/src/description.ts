/**
 * description.json: numbered, specific, checkable claims (the frozen basis for
 * FalseDescription disputes). descriptionHash = sha256(exact description.json bytes);
 * write it with `serializeDescription` (canonical JSON).
 *
 * Header: `type: "envmarket.description.v1"` and/or `schemaVersion: "1"` (at least one).
 * Claim: { id: "C<n>", text, category, check?: how to verify it, checkable?: true } — every claim
 * must be checkable: either `check` (non-empty) or `checkable: true` must be present, and
 * `checkable: false` is rejected. Categories are free-form identifiers; CLAIM_CATEGORIES lists
 * suggested ones.
 */
import type { Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, fromUtf8, sha256Hex } from './hash.ts';

export const DESCRIPTION_TYPE = 'envmarket.description.v1';

export const CLAIM_CATEGORIES = [
  'taskCount',
  'skills',
  'difficulty',
  'grader',
  'dependencies',
  'runtime',
  'network',
  'determinism',
  'budgets',
  'resources',
  'license',
  'provenance',
  'other',
] as const;

export const claimSchema = z
  .looseObject({
    id: z.string().regex(/^C[1-9][0-9]*$/, 'claim ids are "C1", "C2", ...'),
    text: z.string().min(1).max(1000),
    category: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'category must be a short identifier'),
    check: z.string().min(1).optional(),
    checkable: z.literal(true).optional(),
  })
  .refine((c) => c.check !== undefined || c.checkable === true, 'claim must be checkable (provide `check` or `checkable: true`)');

export const descriptionSchema = z
  .looseObject({
    type: z.literal(DESCRIPTION_TYPE).optional(),
    schemaVersion: z.literal('1').optional(),
    title: z.string().min(1),
    environmentVersion: z.string().min(1),
    summary: z.string().optional(),
    claims: z.array(claimSchema).min(1),
  })
  .superRefine((d, ctx) => {
    if (d.type === undefined && d.schemaVersion === undefined) {
      ctx.addIssue({ code: 'custom', message: `need type "${DESCRIPTION_TYPE}" or schemaVersion "1"`, path: ['type'] });
    }
    const seen = new Set<string>();
    for (const c of d.claims) {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate claim id ${c.id}`, path: ['claims'] });
      seen.add(c.id);
    }
  });

export type Claim = z.infer<typeof claimSchema>;
export type Description = z.infer<typeof descriptionSchema>;

export function parseDescription(input: unknown): Description {
  const v = typeof input === 'string' || input instanceof Uint8Array ? JSON.parse(typeof input === 'string' ? input : fromUtf8(input)) : input;
  return descriptionSchema.parse(v);
}

export function serializeDescription(d: Description): string {
  return canonicalJson(descriptionSchema.parse(d));
}

export function descriptionHash(d: Description | string | Uint8Array): Hex {
  return typeof d === 'string' || d instanceof Uint8Array ? sha256Hex(d) : sha256Hex(serializeDescription(d));
}

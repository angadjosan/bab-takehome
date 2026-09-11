/**
 * description.json: numbered, specific, checkable claims (the frozen basis for
 * FalseDescription disputes). descriptionHash = sha256(exact description.json bytes);
 * write it with `serializeDescription` (canonical JSON).
 */
import type { Hex } from 'viem';
import { z } from 'zod';
import { canonicalJson, fromUtf8, sha256Hex } from './hash.ts';

export const CLAIM_CATEGORIES = [
  'scope',
  'tasks',
  'skills',
  'grader',
  'dependencies',
  'execution',
  'determinism',
  'resources',
  'network',
  'license',
  'provenance',
  'other',
] as const;

export const claimSchema = z.strictObject({
  id: z.string().regex(/^C[1-9][0-9]*$/, 'claim ids are "C1", "C2", ...'),
  text: z.string().min(1).max(600),
  category: z.enum(CLAIM_CATEGORIES),
  checkable: z.literal(true),
});

export const descriptionSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    title: z.string().min(1),
    environmentVersion: z.string().min(1),
    summary: z.string().optional(),
    claims: z.array(claimSchema).min(1),
  })
  .superRefine((d, ctx) => {
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

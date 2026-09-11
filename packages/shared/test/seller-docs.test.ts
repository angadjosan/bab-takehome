/** Integration check: the seller workspace's real listing documents parse with the shared schemas. */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { descriptionHash, manifestSchema, parseDescription, sha256Hex } from '../src/index.ts';

const LISTING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../seller-workspace/py-repair-kit/listing');
const DESC = path.join(LISTING, 'description.json');
const MANIFEST = path.join(LISTING, 'manifest.template.json');

describe.skipIf(!existsSync(DESC))('seller description.json', () => {
  it('parses; hash is over exact bytes', () => {
    const bytes = readFileSync(DESC);
    const d = parseDescription(bytes.toString('utf8'));
    expect(d.claims.length).toBeGreaterThan(0);
    expect(descriptionHash(new Uint8Array(bytes))).toBe(sha256Hex(new Uint8Array(bytes)));
  });
});

describe.skipIf(!existsSync(MANIFEST))('seller manifest template', () => {
  it('parses once <FILL> placeholders are replaced with real values', () => {
    const t = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const d = sha256Hex('x');
    Object.assign(t, { bundleDigest: d, imageDigest: d, taskRoot: d, auditRoot: d });
    t.commercialTerms.price = '2000000';
    t.commercialTerms.collateral = '2000000';
    t.referenceProtocol.decoding.maxTokens = 4096;
    const r = manifestSchema.safeParse(t);
    if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
    expect(r.data.taskIds?.length).toBe(r.data.taskCount);
  });
});

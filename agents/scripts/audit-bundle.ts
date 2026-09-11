/**
 * Dev tool: audit an extracted bundle against a description offline (no chain, no TEE).
 *
 *   tsx scripts/audit-bundle.ts <bundleDir> <description.json> [--no-llm] [--out findings.json]
 *
 * Same code path as `buyer inspect` (offline docker sandbox + mechanical checks + LLM).
 */
import * as fs from 'node:fs';
import { auditBundle } from '../src/buyer/inspect.ts';

const args = process.argv.slice(2);
const [bundle, descFile] = args.filter((a) => !a.startsWith('--'));
if (!bundle || !descFile) {
  console.error('usage: tsx scripts/audit-bundle.ts <bundleDir> <description.json> [--no-llm] [--out file]');
  process.exit(64);
}
const outIdx = args.indexOf('--out');
const description = JSON.parse(fs.readFileSync(descFile, 'utf8'));
const a = await auditBundle(bundle, description, { llm: !args.includes('--no-llm') });
if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1]!, JSON.stringify(a, null, 2));
console.log(`contradicted: ${a.claims.filter((c) => c.status === 'contradicted').map((c) => `${c.claimId}(${c.affectedTasks.join(',') || 'all'})`).join(' ') || 'none'}`);

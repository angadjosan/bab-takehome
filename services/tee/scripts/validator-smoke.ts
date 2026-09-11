/**
 * Run the envmarket.validator.v2 prompt once, locally, against a seller workspace (no TEE, no chain):
 *   npx tsx services/tee/scripts/validator-smoke.ts seller-workspace/py-repair-kit
 * Reads FIREWORKS_API_KEY from the environment or the repo-root .env. Mirrors preview.ts: the model
 * sees the claims, the manifest, rough preflight facts and the payload files minus solutions/ (the
 * audit tasks and solutions only feed the screening index). Prints the releasable block and, to
 * stderr, private diagnostics (usage, blanked fields). Nothing is written.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { llmConfigFromEnv, MODELS } from '@envmarket/shared';
import { llmClient } from '../src/models.ts';
import { buildScreeningIndex, buildValidatorInput, collectFiles, descriptionClaims, runValidator } from '../src/validator.ts';

const dir = path.resolve(process.argv[2] ?? 'seller-workspace/py-repair-kit');
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const env: Record<string, string | undefined> = { ...process.env };
if (!env.FIREWORKS_API_KEY && fs.existsSync(path.join(repoRoot, '.env'))) {
  const m = fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').match(/^FIREWORKS_API_KEY=["']?([^"'\n]+)/m);
  if (m) env.FIREWORKS_API_KEY = m[1];
}
const model = process.env.VALIDATOR_MODEL ?? MODELS.validator;

const descriptionJson = fs.readFileSync(path.join(dir, 'listing/description.json'), 'utf8');
const descriptionMd = fs.existsSync(path.join(dir, 'listing/description.md')) ? fs.readFileSync(path.join(dir, 'listing/description.md'), 'utf8') : '';
const manifestJson = fs.readFileSync(path.join(dir, 'listing/manifest.template.json'), 'utf8');
const manifest = JSON.parse(manifestJson) as { taskIds: string[] };
const all = collectFiles(dir).filter((f) => !f.path.startsWith('listing/'));
const payload = all.filter((f) => !f.path.startsWith('audit-tasks/'));
const auditIds = fs.existsSync(path.join(dir, 'audit-tasks')) ? fs.readdirSync(path.join(dir, 'audit-tasks')).filter((n) => /^A\d+$/.test(n)) : [];

// rough stand-in for the runner's preflight (hidden test functions per task, counted by regex)
const hiddenCount = (root: string, id: string) => {
  const d = path.join(dir, root, id, 'tests');
  if (!fs.existsSync(d)) return null;
  return fs.readdirSync(d).filter((n) => n.endsWith('.py')).reduce((s, n) => s + (fs.readFileSync(path.join(d, n), 'utf8').match(/^\s*def test_/gm)?.length ?? 0), 0);
};
const preflight = {
  dependencies: true,
  graderImports: true,
  purchased: manifest.taskIds.map((taskId) => ({ taskId, hiddenTestCount: hiddenCount('tasks', taskId), startFails: true, referenceSolutionPasses: true })),
  auditTaskCount: auditIds.length,
  sandbox: 'local smoke run (preflight approximated by the script)',
};

const idx = buildScreeningIndex({ files: all, taskIds: [...manifest.taskIds, ...auditIds], publicTexts: [descriptionJson, descriptionMd, manifestJson] });
const input = buildValidatorInput({ files: payload.filter((f) => !f.path.startsWith('solutions/')), descriptionJson, manifestJson, preflight });
const cfg = llmConfigFromEnv('validator', env);
const client = llmClient({ provider: 'fireworks', baseUrl: cfg.baseURL, apiKey: cfg.apiKey ?? null } as never);
console.error(`validator ${model} on ${path.basename(dir)}: ${input.length} input chars`);
const r = await runValidator(client, model, input, idx, { temperature: 0, seed: 1337, maxTokens: 8192 }, descriptionClaims(descriptionJson).map((c) => c.id));
const { private: priv, ...block } = r;
console.error(JSON.stringify({ error: priv.error, servedModel: priv.servedModel, usage: priv.usage, costUsd: priv.costUsd, modelClaims: priv.structured?.claims.length }, null, 1));
// private diagnostic (local only): the raw text of any blanked field
for (const c of priv.structured?.claims ?? []) if (c.basis.trim() && !block.claims.some((x) => x.id === c.id && x.basis)) console.error(`blanked ${c.id} (${c.verdict}): ${c.basis}`);
if (priv.structured?.notes.trim() && !block.notes) console.error(`blanked notes: ${priv.structured.notes}`);
console.log(JSON.stringify(block, null, 2));

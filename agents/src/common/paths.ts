/** Filesystem locations used by the agents. All private agent state lives under agents/.data (gitignored). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(AGENTS_ROOT, '..');

export function dataDir(): string {
  return path.resolve(process.env.AGENTS_DATA_DIR ?? path.join(AGENTS_ROOT, '.data'));
}

export function sellerWorkspace(): string {
  return path.resolve(process.env.SELLER_WORKSPACE ?? path.join(REPO_ROOT, 'seller-workspace', 'py-repair-kit'));
}

/** Directory for a packaged version; the version string is sanitized ("py-repair-kit@1.0.0" → "py-repair-kit_1.0.0"). */
export function sellerVersionDir(envVersion: string): string {
  const safe = envVersion.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error(`unsafe environment version ${JSON.stringify(envVersion)}`);
  return path.join(dataDir(), 'seller', safe);
}

export function buyerDir(who: string): string {
  return path.join(dataDir(), 'buyer', who);
}

/** Purchase ids are global on-chain, so one directory per purchase: .data/buyer/<purchaseId>/ */
export function purchaseDir(purchaseId: bigint | string): string {
  const id = String(purchaseId);
  if (!/^[0-9]+$/.test(id)) throw new Error(`bad purchase id ${id}`);
  return path.join(dataDir(), 'buyer', id);
}

export function policyFile(who: string): string {
  return path.join(dataDir(), 'buyer', `policy-${who}.json`);
}

export function ensureDir(p: string, mode = 0o700): string {
  fs.mkdirSync(p, { recursive: true, mode });
  return p;
}

export function writeJson(file: string, value: unknown, mode = 0o600): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n', { mode });
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

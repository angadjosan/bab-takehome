import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

export const CAST = path.join(homedir(), '.foundry', 'bin', 'cast');
export const ANVIL = path.join(homedir(), '.foundry', 'bin', 'anvil');
export const hasCast = existsSync(CAST);
export const hasAnvil = existsSync(ANVIL);

export function cast(...args: string[]): string {
  return execFileSync(CAST, args, { encoding: 'utf8' }).trim();
}

export function tmp(prefix = 'envmarket-shared-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function which(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** anvil's well-known dev account #0 key (public test key, holds no real funds). */
export const ANVIL_PK0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const ANVIL_ADDR0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

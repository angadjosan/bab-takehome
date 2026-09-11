/** Shared service context passed to every component. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { envMarketDomain, type EnvMarketDomain } from '@envmarket/shared';
import type { Attestor } from './attestation.ts';
import type { Chain_ } from './chain.ts';
import type { ServiceConfig } from './config.ts';
import type { ServiceKeys } from './keys.ts';
import type { SandboxInfo } from './sandbox.ts';
import type { BlobStore, PrivateStore } from './store.ts';

export interface Ctx {
  cfg: ServiceConfig;
  keys: ServiceKeys;
  blobs: BlobStore;
  priv: PrivateStore;
  sandbox: SandboxInfo;
  chain: Chain_ | null;
  attestor: Attestor;
  workRoot: string;
  cacheRoot: string;
}

export function domainOf(ctx: Ctx): EnvMarketDomain {
  if (!ctx.chain) throw new Error('no chain configured (MARKET_ADDRESS / deployments file)');
  return envMarketDomain(ctx.chain.chainId, ctx.chain.market);
}

export function requireChain(ctx: Ctx): Chain_ {
  if (!ctx.chain) throw new Error('no chain configured (MARKET_ADDRESS / deployments file)');
  return ctx.chain;
}

export function ensureDirs(dataDir: string): { workRoot: string; cacheRoot: string } {
  const workRoot = path.join(dataDir, 'work');
  const cacheRoot = path.join(dataDir, 'cache');
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o711 });
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o711 });
  // private records: root-only
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.join(dataDir, 'private'), 0o700);
    fs.chmodSync(dataDir, 0o711);
  } catch {
    /* best effort */
  }
  return { workRoot, cacheRoot };
}

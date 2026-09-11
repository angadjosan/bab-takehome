/** Entry point: `tsx src/main.ts` (Docker CMD) or `npm run dev` (local dev, labeled none-local-dev). */
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import { importCacheDir } from './cache.ts';
import { Attestor } from './attestation.ts';
import { Chain_, marketAbi } from './chain.ts';
import { loadConfig } from './config.ts';
import { ensureDirs, type Ctx } from './context.ts';
import { loadServiceKeys } from './keys.ts';
import { errMsg, logger } from './log.ts';
import { detectSandbox, unavailableSandbox } from './sandbox.ts';
import { buildApp } from './server.ts';
import { BlobStore, PrivateStore } from './store.ts';
import { Watcher } from './watcher.ts';

export async function startService(overrides: Partial<Record<string, string>> = {}): Promise<{ ctx: Ctx; close: () => Promise<void>; port: number }> {
  const cfg = loadConfig(overrides);
  const keys = loadServiceKeys(process.env);
  // The mnemonic has been consumed; drop it from this process's env so no child ever inherits it.
  delete process.env.MNEMONIC;
  const { workRoot, cacheRoot } = ensureDirs(cfg.dataDir);
  const blobs = new BlobStore(cfg.dataDir);
  const priv = new PrivateStore(cfg.dataDir, keys.storageKey);
  let sandbox;
  try {
    sandbox = detectSandbox(cfg.sandbox.mode, cfg.sandbox.image);
  } catch (e) {
    logger.error('sandbox unavailable: uploads, previews and mechanical reruns are disabled', { error: errMsg(e) });
    sandbox = unavailableSandbox(errMsg(e));
  }
  const chain = cfg.market ? new Chain_(cfg.chainId, cfg.rpcUrl, cfg.market, keys.account, marketAbi(cfg.repoRoot)) : null;
  const attestor = new Attestor(process.env, keys.account.address, keys.encPublicKey, keys.source, cfg.chainId, cfg.market);
  await attestor.refresh();
  const ctx: Ctx = { cfg, keys, blobs, priv, sandbox, chain, attestor, workRoot, cacheRoot };
  if (cfg.rawEnv.PREVIEW_CACHE_IMPORT_DIR) {
    const n = await importCacheDir(ctx, path.resolve(cfg.rawEnv.PREVIEW_CACHE_IMPORT_DIR));
    logger.info('preview cache import dir processed', { imported: n });
  }

  logger.info('service starting', {
    signer: keys.account.address,
    keySource: keys.source,
    attestation: attestor.state.kind,
    chainId: cfg.chainId,
    market: cfg.market,
    sandbox: sandbox.description,
    inference: cfg.llm.provider,
  });
  if (chain) {
    try {
      const [r, l, v] = await Promise.all([chain.hasRole('isRunner'), chain.hasRole('isRelay'), chain.hasRole('isVerifier')]);
      logger.info('on-chain roles', { runner: r, relay: l, verifier: v });
    } catch (e) {
      logger.warn('could not read roles', { error: errMsg(e) });
    }
  } else logger.warn('no market configured: chain features disabled');

  const watcher = chain && cfg.watcher ? new Watcher(ctx) : null;
  watcher?.start();
  const app = buildApp(ctx, watcher);
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host });
  // previews can take many minutes: disable node's request/headers timeouts
  (server as unknown as { requestTimeout: number; headersTimeout: number }).requestTimeout = 0;
  (server as unknown as { requestTimeout: number; headersTimeout: number }).headersTimeout = 0;
  logger.info('listening', { url: `http://${cfg.host}:${cfg.port}`, publicUrl: cfg.publicUrl });
  return {
    ctx,
    port: cfg.port,
    close: () =>
      new Promise((resolve) => {
        watcher?.stop();
        server.close(() => resolve());
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  startService().catch((e) => {
    logger.error('fatal', { error: errMsg(e) });
    process.exit(1);
  });
}

#!/usr/bin/env tsx
/**
 * Export preview-cache entries SEALED to another TEE service (e.g. seed the EigenCompute deployment
 * with a preview that already ran locally, or carry it across a contract redeploy).
 *
 *   tsx scripts/export-preview-cache.ts --data-dir .data-e2e/tee-data \
 *       (--to-url https://<tee-host> | --to-enc-pub 0x<x25519>) --out ./cache-export [--post]
 *
 * Source keys: MNEMONIC (if set) else RUNNER_PK from the repo .env — i.e. the same key material
 * the source service used for its encrypted store. Each entry is written as <out>/<key>.json
 * (EMENC1 + EMKW1 to the recipient's X25519 key). With --post (requires --to-url) each file is
 * POSTed to <url>/preview-cache/import. The recipient accepts only entries signed by itself or by
 * an address in its PREVIEW_CACHE_TRUSTED_SIGNERS; rebuilt reports carry `cachedFrom` and keep the
 * original run's attestation kind (a local-dev run stays labeled none-local-dev).
 * Or copy the files into the recipient's PREVIEW_CACHE_IMPORT_DIR (imported at startup).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv } from '@envmarket/shared';
import type { Hex } from 'viem';
import { CACHE_NS, entrySigner, sealEntry, type PreviewCacheEntry } from '../src/cache.ts';
import { loadServiceKeys } from '../src/keys.ts';
import { PrivateStore } from '../src/store.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg('data-dir') ?? process.env.DATA_DIR ?? '.data');
  const out = path.resolve(arg('out') ?? 'preview-cache-export');
  const toUrl = arg('to-url')?.replace(/\/+$/, '');
  let recipient = arg('to-enc-pub') as Hex | undefined;
  if (!recipient && toUrl) recipient = ((await (await fetch(`${toUrl}/health`)).json()) as { encPubKey: Hex }).encPubKey;
  if (!recipient || !/^0x[0-9a-fA-F]{64}$/.test(recipient)) throw new Error('need --to-url or --to-enc-pub (recipient X25519 public key)');
  loadEnv({});
  const keys = loadServiceKeys(process.env);
  const store = new PrivateStore(dataDir, keys.storageKey);
  const ids = store.list(CACHE_NS);
  if (!ids.length) throw new Error(`no preview-cache entries in ${dataDir} (readable with ${keys.source} key ${keys.account.address})`);
  fs.mkdirSync(out, { recursive: true });
  for (const id of ids) {
    const e = store.get<PreviewCacheEntry>(CACHE_NS, id)!;
    const signer = await entrySigner(e);
    const sealed = sealEntry(e, recipient);
    const file = path.join(out, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(sealed, null, 1));
    console.log(`sealed ${e.environmentVersion} key=${e.key} producer=${signer ?? 'UNSIGNED'} run=${e.original.runAt} (${e.original.attestationKind}) -> ${file}`);
    if (process.argv.includes('--post')) {
      if (!toUrl) throw new Error('--post needs --to-url');
      const r = await fetch(`${toUrl}/preview-cache/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sealed) });
      console.log(`  POST ${toUrl}/preview-cache/import -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

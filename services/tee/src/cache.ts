/**
 * Preview cache: run the reference panel ONCE per environment and protocol, reuse it for every
 * later version / listing / contract / chain with the same content.
 *
 * key = sha256(canonical JSON {bundleHash, auditRoot, protocolId, harnessDigest, promptDigest,
 *        validatorPromptHash, panel [{requested, resolved, status}], validatorModel})
 * — NOT versionId, market or chain. Entries live in the encrypted private store (namespace
 * "preview-cache") under DATA_DIR and hold the public report parts plus the private run records
 * (unrounded per-episode outcomes, final workspaces for deterministic re-grading).
 *
 * Portability: an entry is signed (EIP-191 over its sha256) by the runner that produced it and can
 * be exported SEALED to another service's X25519 key (EMENC1 + EMKW1, HKDF info
 * "envmarket.cache-export.v1", salt = sha256(ciphertext)). The importer only accepts entries
 * signed by itself or by PREVIEW_CACHE_TRUSTED_SIGNERS. A report rebuilt from an entry keeps the
 * original run's jobs/dates and records `cachedFrom`; if the original run was not attested
 * (local dev), the rebuilt report is labeled `none-local-dev` too — reuse never upgrades trust.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  canonicalJson,
  encryptFile,
  decryptFile,
  fromBase64,
  randomKey,
  sha256Hex,
  toBase64,
  unwrapKey,
  wrapKey,
  type Report,
} from '@envmarket/shared';
import { getAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import type { Ctx } from './context.ts';
import type { EpisodeResult } from './harness.ts';
import { errMsg, logger } from './log.ts';
import type { ResolvedModels } from './models.ts';

export const CACHE_NS = 'preview-cache';
export const EXPORT_INFO = 'envmarket.cache-export.v1';

export interface PreviewCacheKeyInput {
  bundleHash: string;
  auditRoot: string;
  protocolId: string;
  harnessDigest: string;
  promptDigest: string;
  validatorPromptHash: string;
  panel: Array<{ requested: string; resolved: string | null; status: string }>;
  validatorModel: string | null;
}

export function previewCacheKey(k: PreviewCacheKeyInput): Hex {
  return sha256Hex(
    canonicalJson({
      type: 'envmarket.preview-cache-key.v1',
      ...k,
      bundleHash: k.bundleHash.toLowerCase(),
      auditRoot: k.auditRoot.toLowerCase(),
      panel: k.panel.map((p) => ({ requested: p.requested, resolved: p.resolved, status: p.status })),
    }),
  );
}

export interface PreviewCacheEntry {
  type: 'envmarket.preview-cache.v1';
  key: Hex;
  keyInput: PreviewCacheKeyInput;
  environmentVersion: string;
  original: {
    versionId: string;
    chainId: number;
    market: string;
    runAt: string;
    reportHash: string;
    signer: string;
    attestationKind: Report['attestation']['kind'];
    appId: string | null;
    sandbox: string;
  };
  /** public report parts reused verbatim */
  report: Pick<Report, 'protocol' | 'models' | 'uncertainty' | 'validator' | 'jobs' | 'runtime'>;
  /** private run records (never published) */
  models: ResolvedModels;
  episodes: EpisodeResult[];
  validatorPrivate: unknown;
  spec: Record<string, unknown>;
  producer: string;
  producerSignature?: Hex;
}

const unsigned = (e: PreviewCacheEntry) => {
  const { producerSignature: _s, ...rest } = e;
  return rest;
};

export function entryDigest(e: PreviewCacheEntry): Hex {
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(unsigned(e))) as Record<string, unknown>));
}

export async function signEntry(ctx: Ctx, e: PreviewCacheEntry): Promise<PreviewCacheEntry> {
  const producer = ctx.keys.account.address;
  const withProducer = { ...e, producer };
  const sig = await ctx.keys.account.signMessage({ message: { raw: entryDigest(withProducer) } });
  return { ...withProducer, producerSignature: sig };
}

export async function entrySigner(e: PreviewCacheEntry): Promise<Address | null> {
  if (!e.producerSignature) return null;
  try {
    const a = await recoverMessageAddress({ message: { raw: entryDigest(e) }, signature: e.producerSignature });
    return a.toLowerCase() === e.producer.toLowerCase() ? a : null;
  } catch {
    return null;
  }
}

export function getCacheEntry(ctx: Ctx, key: Hex): PreviewCacheEntry | null {
  return ctx.priv.get<PreviewCacheEntry>(CACHE_NS, key.slice(2));
}

export function putCacheEntry(ctx: Ctx, e: PreviewCacheEntry): void {
  ctx.priv.put(CACHE_NS, e.key.slice(2), e);
}

export function listCacheKeys(ctx: Ctx): string[] {
  return ctx.priv.list(CACHE_NS);
}

// ------------------------------------------------------------------------------ export/import
export interface SealedCacheExport {
  type: 'envmarket.preview-cache-export.v1';
  key: Hex;
  bundleHash: string;
  environmentVersion: string;
  producer: string;
  recipientEncPubKey: Hex;
  ciphertext: string; // base64 EMENC1(K, canonical entry JSON)
  wrappedKey: string; // base64 EMKW1(K) to recipientEncPubKey, salt = sha256(ciphertext)
  exportedAt: string;
}

export function sealEntry(e: PreviewCacheEntry, recipientEncPubKey: Hex): SealedCacheExport {
  const k = randomKey();
  const ct = encryptFile(k, new TextEncoder().encode(JSON.stringify(e)));
  return {
    type: 'envmarket.preview-cache-export.v1',
    key: e.key,
    bundleHash: e.keyInput.bundleHash,
    environmentVersion: e.environmentVersion,
    producer: e.producer,
    recipientEncPubKey: recipientEncPubKey.toLowerCase() as Hex,
    ciphertext: toBase64(ct),
    wrappedKey: toBase64(wrapKey({ key: k, recipientPublicKey: recipientEncPubKey, wrapperHash: sha256Hex(ct), info: EXPORT_INFO })),
    exportedAt: new Date().toISOString(),
  };
}

export function trustedCacheSigners(ctx: Ctx): Set<string> {
  const s = new Set<string>([ctx.keys.account.address.toLowerCase()]);
  for (const a of (ctx.cfg.rawEnv.PREVIEW_CACHE_TRUSTED_SIGNERS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      s.add(getAddress(a).toLowerCase());
    } catch {
      /* ignore malformed */
    }
  }
  return s;
}

export async function importSealed(ctx: Ctx, sealed: SealedCacheExport): Promise<{ key: Hex; producer: string; replaced: boolean }> {
  if (sealed?.type !== 'envmarket.preview-cache-export.v1') throw new Error('not a preview cache export');
  if (sealed.recipientEncPubKey.toLowerCase() !== ctx.keys.encPublicKey.toLowerCase()) throw new Error('export is sealed to a different service key');
  const ct = fromBase64(sealed.ciphertext);
  const k = unwrapKey({ blob: fromBase64(sealed.wrappedKey), recipientSecretKey: ctx.keys.encSecretKey, wrapperHash: sha256Hex(ct), info: EXPORT_INFO });
  const entry = JSON.parse(new TextDecoder().decode(decryptFile(k, ct))) as PreviewCacheEntry;
  if (entry.type !== 'envmarket.preview-cache.v1' || entry.key !== previewCacheKey(entry.keyInput)) throw new Error('cache entry key does not match its key input');
  const signer = await entrySigner(entry);
  if (!signer) throw new Error('cache entry signature invalid');
  if (!trustedCacheSigners(ctx).has(signer.toLowerCase())) throw new Error(`cache entry producer ${signer} is not trusted (PREVIEW_CACHE_TRUSTED_SIGNERS)`);
  const replaced = !!getCacheEntry(ctx, entry.key);
  putCacheEntry(ctx, entry);
  ctx.priv.appendLog('preview-cache', { kind: 'import', key: entry.key, producer: signer, bundleHash: entry.keyInput.bundleHash });
  return { key: entry.key, producer: signer, replaced };
}

/** Import every *.json sealed export in `dir` (startup seeding). Errors are logged, not fatal. */
export async function importCacheDir(ctx: Ctx, dir: string): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const r = await importSealed(ctx, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SealedCacheExport);
      n++;
      logger.info('preview cache imported', { file: f, key: r.key, producer: r.producer });
    } catch (e) {
      logger.warn('preview cache import skipped', { file: f, error: errMsg(e) });
    }
  }
  return n;
}

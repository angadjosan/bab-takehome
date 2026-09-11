/** HTTP API (Hono). See README for the full contract. */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { KEYWRAP_MAGIC, sha256Hex, UPLOAD_KEYWRAP_INFO } from '@envmarket/shared';
import { processUpload, UploadError } from './bundle.ts';
import type { Ctx } from './context.ts';
import { casePacket, storeEvidence } from './evidence.ts';
import { errMsg, logger } from './log.ts';
import { attachStoredReport, disclosures, getStoredReport, HttpError, previewPreconditions, previewState, previewVersion, protocolCommitment, protocolSpec, quotePreview } from './preview.ts';
import { getCacheEntry, importSealed, listCacheKeys, type SealedCacheExport } from './cache.ts';
import { serveDelivery } from './relay.ts';
import { normHash } from './store.ts';
import { RateLimiter } from './util.ts';
import { VALIDATOR_SYSTEM_PROMPT, validatorOutputSchema, validatorPromptHash, VALIDATOR_PROMPT_VERSION } from './validator.ts';
import type { Watcher } from './watcher.ts';
import { z } from 'zod';

const MAX_BODY = 64 * 1024 * 1024;

function parseId(s: string): bigint {
  if (!/^[0-9]{1,30}$/.test(s)) throw new HttpError(400, 'id must be a decimal integer');
  return BigInt(s);
}

async function jsonBody(c: Context): Promise<Record<string, any>> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, 'body too large');
  try {
    const v = await c.req.json();
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v as Record<string, any>;
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

const bigintSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function buildApp(ctx: Ctx, watcher: Watcher | null): Hono {
  const app = new Hono();
  const perListing = new RateLimiter(ctx.cfg.preview.ratePerListingPerHour, 3_600_000);
  const global = new RateLimiter(ctx.cfg.preview.rateGlobalPerHour, 3_600_000);

  // Browser clients (apps/web) read public docs/reports/deliveries and POST evidence cross-origin.
  // Permissive, credential-less CORS: nothing here relies on cookies or ambient authority.
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'], allowHeaders: ['content-type'], exposeHeaders: ['x-sha256'], maxAge: 600 }));

  app.use('*', async (c, next) => {
    const t0 = Date.now();
    await next();
    const entry = { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - t0, ip: c.req.header('x-forwarded-for') ?? null };
    logger.info('http', entry);
    try {
      ctx.priv.appendLog('requests', entry);
    } catch {
      /* logging must never break a request */
    }
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, details: bigintSafe(err.details ?? null) }, err.status as 400);
    if (err instanceof UploadError) return c.json({ error: err.message, checks: err.checks }, err.status as 400);
    logger.error('unhandled', { path: c.req.path, error: errMsg(err) });
    return c.json({ error: errMsg(err) }, 500);
  });

  app.get('/', (c) => c.redirect('/health'));

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'envmarket-tee',
      signer: ctx.keys.account.address,
      encPubKey: ctx.keys.encPublicKey,
      keySource: ctx.keys.source,
      chainId: ctx.chain?.chainId ?? ctx.cfg.chainId,
      market: ctx.chain?.market ?? null,
      attestation: {
        vendor: ctx.attestor.state.vendor,
        kind: ctx.attestor.state.kind,
        appId: ctx.attestor.state.appId,
        composeHash: ctx.attestor.state.composeHash,
        imageDigest: ctx.attestor.state.imageDigest,
        verifyUrl: ctx.attestor.state.verifyUrl,
        quoteDigest: ctx.attestor.state.quoteDigest,
        encPubKey: ctx.keys.encPublicKey,
      },
      sandbox: ctx.sandbox.description,
      inference: { provider: ctx.cfg.llm.provider, baseUrl: ctx.cfg.llm.baseUrl, keyConfigured: !!ctx.cfg.llm.apiKey || ctx.cfg.llm.provider === 'ollama' },
      submitTxs: ctx.cfg.submitTxs,
      watcher: watcher?.status() ?? null,
      uploadKeyWrap: {
        format: KEYWRAP_MAGIC,
        scheme: 'shared wrapKey (EMKW2 = HPKE RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM)',
        recipient: 'encPubKey',
        aad: 'sha256(encryptedBundle)',
        info: UPLOAD_KEYWRAP_INFO,
      },
    }),
  );

  app.get('/attestation', async (c) => {
    if (c.req.query('refresh') === '1' || (ctx.attestor.state.kind !== 'none-local-dev' && !ctx.attestor.state.token)) await ctx.attestor.refresh();
    return c.json({ ...ctx.attestor.state, signerRoles: ctx.chain ? await roles(ctx) : null });
  });

  app.get('/protocol', (c) =>
    c.json({
      spec: ctx.harness ? protocolSpec(ctx) : null,
      specCommitment: ctx.harness ? protocolCommitment(ctx, null).digest : null,
      harness: ctx.harness ? ctx.harness.digest : { error: 'reference harness unavailable' },
      validator: { promptVersion: VALIDATOR_PROMPT_VERSION, system: VALIDATOR_SYSTEM_PROMPT, schema: z.toJSONSchema(validatorOutputSchema), promptHash: validatorPromptHash() },
    }),
  );

  // ------------------------------------------------------------------ blobs
  app.put('/blobs', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_BODY) throw new HttpError(413, 'blob too large');
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BODY) throw new HttpError(400, 'empty or oversized blob');
    const h = ctx.blobs.put(buf);
    return c.json({ sha256: h, bytes: buf.length, url: `${ctx.cfg.publicUrl}/blobs/${h.slice(2)}` });
  });
  app.get('/blobs/:hash', (c) => {
    let h: string;
    try {
      h = normHash(c.req.param('hash'));
    } catch {
      throw new HttpError(400, 'bad hash');
    }
    const b = ctx.blobs.get(h);
    if (!b) throw new HttpError(404, 'not found');
    return c.body(Buffer.from(b) as unknown as ArrayBuffer, 200, { 'content-type': 'application/octet-stream', 'x-sha256': h, 'cache-control': 'public, max-age=31536000, immutable' });
  });

  // ------------------------------------------------------------------ seller
  app.post('/seller/upload', async (c) => {
    if (ctx.sandbox.kind === 'unavailable') throw new HttpError(503, `sandbox ${ctx.sandbox.description}`);
    const body = await jsonBody(c);
    const { response } = await processUpload(ctx, body);
    return c.json(response);
  });

  // ------------------------------------------------------------------ preview
  app.post('/preview/:versionId', async (c) => {
    const versionId = parseId(c.req.param('versionId'));
    const cached = getStoredReport(ctx, versionId);
    if (!cached) {
      const { terms } = await previewPreconditions(ctx, versionId);
      const lk = `listing:${terms.listingId}`;
      if (!perListing.take(lk)) throw new HttpError(429, `preview rate limit for listing ${terms.listingId}; retry in ${perListing.retryAfterSec(lk)}s`);
      if (!global.take('global')) throw new HttpError(429, `global preview rate limit; retry in ${global.retryAfterSec('global')}s`);
    }
    if (c.req.query('async') === '1' && !cached) {
      previewVersion(ctx, versionId).catch(() => undefined); // status via GET /reports/:versionId
      return c.json({ status: 'running', versionId: versionId.toString(), poll: `/reports/${versionId}` }, 202);
    }
    const { stored, cached: wasCached } = await previewVersion(ctx, versionId);
    return c.json({ cached: wasCached, report: stored.report, reportJson: stored.reportJson, reportHash: stored.reportHash, signature: stored.signature, signer: stored.signer, attachTx: stored.attachTx, attachError: stored.attachError, attestationToken: stored.attestationToken, reusedCache: stored.reusedCache, cacheKey: stored.cacheKey, inferenceCostUsd: stored.inferenceCostUsd, feePaidUsdc: stored.feePaidUsdc, quoteHash: stored.quoteHash, disclosures: disclosures(ctx, ctx.cfg.llm.provider), reportUrl: `${ctx.cfg.publicUrl}/blobs/${stored.reportHash.slice(2)}` });
  });
  app.get('/preview/quote/:versionId', async (c) => c.json(await quotePreview(ctx, parseId(c.req.param('versionId')))));

  // ------------------------------------------------------------------ preview cache (sealed import)
  app.post('/preview-cache/import', async (c) => {
    try {
      return c.json(await importSealed(ctx, (await jsonBody(c)) as SealedCacheExport));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, errMsg(e));
    }
  });
  app.get('/preview-cache', (c) =>
    c.json(
      listCacheKeys(ctx).map((k) => {
        const e = getCacheEntry(ctx, `0x${k}`);
        return e ? { key: e.key, environmentVersion: e.environmentVersion, bundleHash: e.keyInput.bundleHash, auditRoot: e.keyInput.auditRoot, protocolId: e.keyInput.protocolId, models: e.keyInput.panel, originalRunAt: e.original.runAt, originalVersionId: e.original.versionId, originalChainId: e.original.chainId, attestationKind: e.original.attestationKind, producer: e.producer } : { key: `0x${k}` };
      }),
    ),
  );

  app.post('/preview/:versionId/attach', async (c) => {
    const s = await attachStoredReport(ctx, parseId(c.req.param('versionId')));
    return c.json({ reportHash: s.reportHash, attachTx: s.attachTx });
  });
  app.get('/reports/:versionId', (c) => {
    const vid = parseId(c.req.param('versionId'));
    const s = getStoredReport(ctx, vid);
    if (!s) {
      const st = previewState(vid);
      if (st.state === 'running') return c.json({ status: 'running', startedAt: st.startedAt }, 202);
      if (st.state === 'failed') return c.json({ status: 'failed', error: st.error, details: bigintSafe(st.details ?? null) }, 500);
      throw new HttpError(404, 'no report for this version yet');
    }
    return c.json({ report: s.report, reportJson: s.reportJson, reportHash: s.reportHash, signature: s.signer ? s.signature : null, signer: s.signer, attachTx: s.attachTx, attestationToken: s.attestationToken, reusedCache: s.reusedCache, cacheKey: s.cacheKey, inferenceCostUsd: s.inferenceCostUsd, feePaidUsdc: s.feePaidUsdc, quoteHash: s.quoteHash, disclosures: disclosures(ctx, ctx.cfg.llm.provider), reportUrl: `${ctx.cfg.publicUrl}/blobs/${s.reportHash.slice(2)}` });
  });

  // ------------------------------------------------------------------ delivery
  app.get('/deliveries/:purchaseId', async (c) => c.json(await serveDelivery(ctx, parseId(c.req.param('purchaseId')))));

  // ------------------------------------------------------------------ evidence
  app.post('/evidence-upload', async (c) => c.json(storeEvidence(ctx, await jsonBody(c))));
  app.post('/evidence/:disputeId', async (c) => c.json(bigintSafe(await casePacket(ctx, parseId(c.req.param('disputeId')), await jsonBody(c)))));

  // ------------------------------------------------------------------ findings (public)
  app.get('/findings/:disputeId', (c) => {
    const r = ctx.priv.get<{ findings: unknown; findingsHash: string; upheld: boolean; confirmedMask: string; tx: string | null; signature: string }>('findings', `d${parseId(c.req.param('disputeId'))}`);
    if (!r) throw new HttpError(404, 'no findings for this dispute');
    return c.json({ findings: r.findings, findingsHash: r.findingsHash, upheld: r.upheld, confirmedMask: r.confirmedMask, signature: r.signature, tx: r.tx });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  void sha256Hex;
  return app;
}

async function roles(ctx: Ctx): Promise<Record<string, boolean | string>> {
  try {
    const [r, l, v] = await Promise.all([ctx.chain!.hasRole('isRunner'), ctx.chain!.hasRole('isRelay'), ctx.chain!.hasRole('isVerifier')]);
    return { runner: r, relay: l, verifier: v };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/**
 * Runtime attestation, one implementation per TEE_VENDOR behind `TeeAttestor`:
 *   - `PhalaAttestor` (Phala Cloud dstack, Intel TDX): a raw DCAP quote with report_data =
 *     sha512(binding), plus the event log and app-compose (see the class comment below);
 *   - `EigenAttestor` (EigenCompute, and the local-dev fallback), documented here.
 *
 * EigenCompute runtime attestation.
 *
 * Inside an EigenCompute app (GCP Confidential Space, Intel TDX) the launcher exposes
 * `unix:/run/container_launcher/teeserver.sock` and the KMS injects KMS_SERVER_URL and
 * KMS_PUBLIC_KEY. This is a faithful port of `@layr-labs/ecloud-sdk@1.0.0` `attest`
 * (AttestClient): request bound evidence from the launcher with a challenge that commits to an
 * ephemeral RSA key, POST it to `$KMS_SERVER_URL/auth/attest`, verify the KMS signature over the
 * response, then decrypt the KMS-issued JWT. The JWT binds `extra_data` (here: sha512 of a
 * canonical JSON that names the service signer and X25519 key, or a report hash).
 *
 * Outside a TEE these calls fail; the service then labels itself `none-local-dev`. Nothing is
 * ever faked: `kind = "eigencompute-tdx"` is only reported when a KMS-issued token was obtained.
 */
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { compactDecrypt } from 'jose';
import { canonicalJson, sha256Hex } from '@envmarket/shared';
import type { Address, Hex } from 'viem';
import { dstackEndpoint, type ServiceKeys, type TeeVendor } from './keys.ts';
import { errMsg, logger } from './log.ts';

const DEFAULT_SOCKET_PATH = '/run/container_launcher/teeserver.sock';
const CHALLENGE_PREFIX = 'COMPUTE_APP_JWT_REQUEST_RSA_KEY_V1';
const SIGNATURE_PREFIX = 'COMPUTE_APP_KMS_SIGNATURE_V1';
const NULL_BYTE = Buffer.from([0]);
export const ATTEST_AUDIENCE = 'envmarket-tee';

export interface AttestConfig {
  kmsServerURL: string;
  kmsPublicKey: string;
  audience: string;
  socketPath?: string;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const buf = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, ''), 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function boundEvidence(socketPath: string, challenge: Buffer, extraData?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ challenge: challenge.toString('base64'), ...(extraData?.length ? { extra_data: extraData.toString('base64') } : {}) });
    const req = http.request(
      { socketPath, path: '/v1/bound_evidence', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`TEE attestation failed (${res.statusCode}): ${Buffer.concat(chunks).toString()}`)),
        );
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('attestation socket timeout')));
    req.on('error', (err) => reject(new Error(`TEE attestation request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

/** Obtain a KMS-signed attestation JWT binding `extraData` (<= 1 MB). Throws outside a TEE. */
export async function attestJwt(cfg: AttestConfig, extraData?: Buffer): Promise<string> {
  if (extraData && extraData.length > 1_048_576) throw new Error('extraData exceeds 1MB');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const challenge = createHash('sha256').update(CHALLENGE_PREFIX).update(NULL_BYTE).update(publicKey).digest();
  const evidence = await boundEvidence(cfg.socketPath ?? DEFAULT_SOCKET_PATH, challenge, extraData);
  const res = await fetch(`${cfg.kmsServerURL}/auth/attest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 3,
      attestation: evidence.toString('base64'),
      rsaKey: publicKey,
      audience: cfg.audience,
      ...(extraData?.length ? { extra_data: extraData.toString('base64') } : {}),
    }),
  });
  if (!res.ok) throw new Error(`KMS attest failed (${res.status}): ${await res.text()}`);
  const resp = (await res.json()) as { data: { encryptedToken: string }; signature: string };
  const msg = Buffer.concat([Buffer.from(SIGNATURE_PREFIX), NULL_BYTE, Buffer.from(JSON.stringify(resp.data))]);
  if (!verify('sha256', msg, cfg.kmsPublicKey, Buffer.from(resp.signature, 'base64'))) throw new Error('KMS response signature verification failed');
  const rsa = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(privateKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const { plaintext } = await compactDecrypt(resp.data.encryptedToken, rsa);
  return (JSON.parse(new TextDecoder().decode(plaintext)) as { token: string }).token;
}

export function sha512(data: string | Uint8Array): Buffer {
  return createHash('sha512').update(data).digest();
}

/**
 * EigenCompute environments (ecloud `--environment`). The demo target is `sepolia` (BUILD_SPEC
 * "Deployment target — FINAL"): AppController on Ethereum Sepolia, same Intel TDX + KMS + attestation.
 * Selected by EIGEN_ENVIRONMENT (default "sepolia"); nothing else hardcodes an environment.
 */
export const EIGEN_ENVIRONMENTS = {
  sepolia: { dashboard: 'https://verify-sepolia.eigencloud.xyz', appController: '0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2', controlChainId: 11155111 },
  'mainnet-alpha': { dashboard: 'https://verify.eigencloud.xyz', appController: '0xc38d35Fc995e75342A21CBd6D770305b142Fbe67', controlChainId: 1 },
} as const;
export type EigenEnvironment = keyof typeof EIGEN_ENVIRONMENTS;
export const DEFAULT_EIGEN_ENVIRONMENT: EigenEnvironment = 'sepolia';

export function eigenEnvironment(name: string | undefined): { name: EigenEnvironment } & (typeof EIGEN_ENVIRONMENTS)[EigenEnvironment] {
  const n = (name && name in EIGEN_ENVIRONMENTS ? name : DEFAULT_EIGEN_ENVIRONMENT) as EigenEnvironment;
  return { name: n, ...EIGEN_ENVIRONMENTS[n] };
}

export type AttestationKind = 'eigencompute-tdx' | 'phala-dstack-tdx' | 'none-local-dev';

export interface AttestationState {
  vendor: TeeVendor;
  kind: AttestationKind;
  /** EigenCompute only (null on Phala). */
  eigenEnvironment: EigenEnvironment | null;
  appController: string | null;
  appControllerChainId: number | null;
  appId: string | null;
  imageDigest: string | null;
  signer: Address;
  encPubKey: Hex;
  keySource: string;
  verifyUrl: string | null;
  /** Canonical JSON the token's extra_data commits to (sha512). */
  binding: string;
  token: string | null;
  tokenClaims: Record<string, unknown> | null;
  quoteDigest: string | null; // sha256 of the JWT (null when no token)
  kmsPublicKey: string | null;
  obtainedAt: string | null;
  error: string | null;
  note: string;
  // ---- Phala dstack only (null for EigenCompute / local) ----
  /** Raw Intel TDX DCAP quote (hex, no 0x). Same value as `token`. */
  quote: string | null;
  /** 0x + sha512(binding): the quote's 64-byte report_data (TD report offset 568 in the quote). */
  reportData: Hex | null;
  /** dstack event log (RTMR0-3 replay; RTMR3 carries app-id, compose-hash, instance-id, key-provider). */
  eventLog: unknown[] | null;
  /** sha256 of `appCompose`; also the RTMR3 `compose-hash` event. */
  composeHash: string | null;
  /** The app-compose.json the CVM booted (its docker_compose_file pins the image by digest). */
  appCompose: string | null;
  instanceId: string | null;
  osImageHash: string | null;
  /** GetKey inputs and the KMS signature chain over the signer key. */
  keyDerivation: { path: string; purpose: string; signatureChain: Hex[] } | null;
  /** Public quote verification endpoint (POST {hex}). */
  verifyApi: string | null;
}

/** Block embedded in report.json, findings and case packets. */
export interface ReportAttestation {
  kind: AttestationKind;
  appId: string | null;
  signer: Address;
  quoteDigest: string | null;
  verifyUrl: string | null;
}

export interface TeeAttestor {
  state: AttestationState;
  /** Try to obtain the binding attestation. Only real TEE evidence upgrades `kind`. */
  refresh(): Promise<AttestationState>;
  /** Attestation over sha512(payload) (e.g. a report hash). Null outside a TEE. */
  tokenFor(payload: string): Promise<string | null>;
  reportBlock(): ReportAttestation;
}

const NO_DSTACK = {
  quote: null,
  reportData: null,
  eventLog: null,
  composeHash: null,
  appCompose: null,
  instanceId: null,
  osImageHash: null,
  keyDerivation: null,
  verifyApi: null,
} as const;

function decodeClaims(jwt: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface AttestationEnv {
  KMS_SERVER_URL?: string;
  KMS_PUBLIC_KEY?: string;
  EIGEN_APP_ID?: string;
  EIGEN_APP_ID_PUBLIC?: string;
  EIGEN_IMAGE_DIGEST?: string;
  EIGEN_VERIFY_URL?: string;
  EIGEN_ENVIRONMENT?: string; // sepolia (default) | mainnet-alpha
  EIGEN_ENVIRONMENT_PUBLIC?: string;
  ATTEST_SOCKET_PATH?: string;
}

/** EigenCompute (and the local-dev fallback, which never obtains a token). Unchanged binding format. */
export class EigenAttestor implements TeeAttestor {
  state: AttestationState;
  #cfg: AttestConfig | null;
  constructor(
    private readonly env: AttestationEnv,
    signer: Address,
    encPubKey: Hex,
    keySource: string,
    chainId: number,
    market: Address | null,
    vendor: 'eigencompute' | 'local' = 'eigencompute',
  ) {
    const appId = env.EIGEN_APP_ID || env.EIGEN_APP_ID_PUBLIC || null;
    const eigenEnv = eigenEnvironment(env.EIGEN_ENVIRONMENT || env.EIGEN_ENVIRONMENT_PUBLIC);
    const dash = eigenEnv.dashboard;
    const binding = canonicalJson({
      type: 'envmarket.tee.binding.v1',
      signer: signer.toLowerCase(),
      encPubKey,
      chainId,
      market: market ? market.toLowerCase() : null,
      appId,
    });
    this.#cfg =
      env.KMS_SERVER_URL && env.KMS_PUBLIC_KEY
        ? { kmsServerURL: env.KMS_SERVER_URL, kmsPublicKey: env.KMS_PUBLIC_KEY.replace(/\\n/g, '\n'), audience: ATTEST_AUDIENCE, socketPath: env.ATTEST_SOCKET_PATH }
        : null;
    this.state = {
      vendor,
      kind: 'none-local-dev',
      eigenEnvironment: eigenEnv.name,
      appController: eigenEnv.appController,
      appControllerChainId: eigenEnv.controlChainId,
      appId,
      imageDigest: env.EIGEN_IMAGE_DIGEST || null,
      signer,
      encPubKey,
      keySource,
      verifyUrl: env.EIGEN_VERIFY_URL || (appId ? `${dash}/app/${appId}` : null),
      binding,
      token: null,
      tokenClaims: null,
      quoteDigest: null,
      kmsPublicKey: this.#cfg?.kmsPublicKey ?? null,
      obtainedAt: null,
      error: null,
      note: 'Local development: no TEE attestation. The host operator can read plaintext. Never the demo path.',
      ...NO_DSTACK,
    };
  }

  /** Try to obtain the binding token. Only a KMS-issued token upgrades kind to eigencompute-tdx. */
  async refresh(): Promise<AttestationState> {
    if (!this.#cfg) {
      this.state.error = 'KMS_SERVER_URL / KMS_PUBLIC_KEY not present (not running inside EigenCompute)';
      return this.state;
    }
    if (!existsSync(this.#cfg.socketPath ?? DEFAULT_SOCKET_PATH)) {
      this.state.error = `attestation socket ${this.#cfg.socketPath ?? DEFAULT_SOCKET_PATH} not present`;
      return this.state;
    }
    try {
      const token = await attestJwt(this.#cfg, sha512(this.state.binding));
      this.state = {
        ...this.state,
        kind: 'eigencompute-tdx',
        token,
        tokenClaims: decodeClaims(token),
        quoteDigest: sha256Hex(token),
        obtainedAt: new Date().toISOString(),
        error: null,
        note: 'KMS-issued runtime attestation JWT (EigenCompute, Confidential Space). extra_data = sha512(binding). Verify the JWT signature with kmsPublicKey, check aud, recompute sha512(binding), and match appId/image digest on the verify dashboard.',
      };
      logger.info('attestation token obtained', { quoteDigest: this.state.quoteDigest });
    } catch (e) {
      this.state.error = errMsg(e);
      logger.warn('attestation failed', { error: this.state.error });
    }
    return this.state;
  }

  /** Attestation JWT binding an arbitrary payload (e.g. a report hash). Null outside a TEE. */
  async tokenFor(payload: string): Promise<string | null> {
    if (this.state.kind !== 'eigencompute-tdx' || !this.#cfg) return null;
    try {
      return await attestJwt(this.#cfg, sha512(payload));
    } catch (e) {
      logger.warn('per-payload attestation failed', { error: errMsg(e) });
      return null;
    }
  }

  reportBlock(): ReportAttestation {
    return { kind: this.state.kind, appId: this.state.appId, signer: this.state.signer, quoteDigest: this.state.quoteDigest, verifyUrl: this.state.verifyUrl };
  }
}

/** Backwards-compatible name for the EigenCompute attestor. */
export { EigenAttestor as Attestor };

// ------------------------------------------------------------------------------ Phala Cloud (dstack)

export const PHALA_VERIFY_API = 'https://cloud-api.phala.com/api/v1/attestations/verify';
export const PHALA_TRUST_CENTER = 'https://trust.phala.com/app';
/** TDX quote v4: 48-byte header, then the TD report; report_data is its last 64 bytes (offset 568). */
export const TDX_REPORT_DATA_OFFSET = 568;

/** The Phala binding. `vendor: "phala"` keeps its bytes distinct from the EigenCompute binding. */
export function phalaBinding(signer: Address, encPubKey: Hex, chainId: number, market: Address | null, appId: string | null): string {
  return canonicalJson({
    type: 'envmarket.tee.binding.v1',
    vendor: 'phala',
    signer: signer.toLowerCase(),
    encPubKey,
    chainId,
    market: market ? market.toLowerCase() : null,
    appId,
  });
}

/** `sha256:<hex>` of the first digest-pinned image in app-compose's docker_compose_file, or null. */
export function composeImageDigest(appCompose: string | null): string | null {
  if (!appCompose) return null;
  try {
    const c = JSON.parse(appCompose) as { docker_compose_file?: string };
    const m = String(c.docker_compose_file ?? '').match(/@sha256:([0-9a-f]{64})/);
    return m ? `sha256:${m[1]}` : null;
  } catch {
    return null;
  }
}

/** 64 bytes of report_data from a hex TDX quote (v4 layout). */
export function quoteReportData(quoteHex: string): string {
  const h = quoteHex.replace(/^0x/, '');
  return h.slice(TDX_REPORT_DATA_OFFSET * 2, TDX_REPORT_DATA_OFFSET * 2 + 128);
}

interface DstackLike {
  info(): Promise<{ app_id: string; instance_id: string; compose_hash: string; os_image_hash?: string; tcb_info: { app_compose?: string; os_image_hash?: string } }>;
  getQuote(reportData: Uint8Array): Promise<{ quote: string; event_log: string }>;
}

/**
 * Phala Cloud dstack CVM (Intel TDX). refresh(): Info → binding (with app_id) → GetQuote(sha512(binding)).
 * `kind = "phala-dstack-tdx"` only when a quote came from the real guest-agent socket; a dstack
 * simulator run fills the same fields for testing but stays `none-local-dev`.
 */
export class PhalaAttestor implements TeeAttestor {
  state: AttestationState;
  #client: DstackLike | null = null;
  constructor(
    private readonly dstack: { endpoint: string; simulated: boolean },
    keys: Pick<ServiceKeys, 'account' | 'encPublicKey' | 'source' | 'dstack'>,
    private readonly chainId: number,
    private readonly market: Address | null,
  ) {
    this.state = {
      vendor: 'phala',
      kind: 'none-local-dev',
      eigenEnvironment: null,
      appController: null,
      appControllerChainId: null,
      appId: null,
      imageDigest: null,
      signer: keys.account.address,
      encPubKey: keys.encPublicKey,
      keySource: keys.source,
      verifyUrl: null,
      binding: phalaBinding(keys.account.address, keys.encPublicKey, chainId, market, null),
      token: null,
      tokenClaims: null,
      quoteDigest: null,
      kmsPublicKey: null,
      obtainedAt: null,
      error: null,
      note: dstack.simulated
        ? 'dstack SIMULATOR: the quote is not from TDX hardware. Not a TEE; the host can read plaintext.'
        : 'No dstack quote obtained yet: not attested.',
      ...NO_DSTACK,
      keyDerivation: keys.dstack ?? null,
      verifyApi: PHALA_VERIFY_API,
    };
  }

  async #dstack(): Promise<DstackLike> {
    if (!this.#client) {
      const { DstackClient } = await import('@envmarket/dstack');
      this.#client = new DstackClient(this.dstack.endpoint) as unknown as DstackLike;
    }
    return this.#client;
  }

  async refresh(): Promise<AttestationState> {
    try {
      const c = await this.#dstack();
      const info = await c.info();
      const binding = phalaBinding(this.state.signer, this.state.encPubKey, this.chainId, this.market, info.app_id);
      const rd = sha512(binding);
      const q = await c.getQuote(rd);
      const quote = q.quote.replace(/^0x/, '').toLowerCase();
      if (quoteReportData(quote) !== rd.toString('hex')) throw new Error('dstack quote report_data != sha512(binding)');
      const appCompose = info.tcb_info?.app_compose ?? null;
      const real = !this.dstack.simulated;
      this.state = {
        ...this.state,
        kind: real ? 'phala-dstack-tdx' : 'none-local-dev',
        appId: info.app_id,
        instanceId: info.instance_id,
        binding,
        token: quote,
        quote,
        quoteDigest: sha256Hex(Buffer.from(quote, 'hex')),
        reportData: `0x${rd.toString('hex')}`,
        eventLog: JSON.parse(q.event_log) as unknown[],
        composeHash: info.compose_hash,
        appCompose,
        imageDigest: composeImageDigest(appCompose),
        osImageHash: info.os_image_hash ?? info.tcb_info?.os_image_hash ?? null,
        verifyUrl: real ? `${PHALA_TRUST_CENTER}/${info.app_id}` : null,
        obtainedAt: new Date().toISOString(),
        error: null,
        note: real
          ? 'Intel TDX DCAP quote from the Phala Cloud dstack guest agent. report_data = sha512(binding). Verify: POST {hex: quote} to verifyApi (quote.verified), check report_data, check sha256(appCompose) = composeHash = the RTMR3 compose-hash event and that appCompose pins the published image digest, and that binding.signer holds the EnvMarket roles. The signer key comes from the dstack KMS for this app id (keyDerivation.signatureChain).'
          : 'dstack SIMULATOR: the quote is not from TDX hardware. Not a TEE; the host can read plaintext.',
      };
      logger.info('dstack attestation quote obtained', { appId: info.app_id, quoteDigest: this.state.quoteDigest, simulated: this.dstack.simulated });
    } catch (e) {
      this.state.error = errMsg(e);
      logger.warn('dstack attestation failed', { error: this.state.error });
    }
    return this.state;
  }

  async tokenFor(payload: string): Promise<string | null> {
    if (this.state.kind !== 'phala-dstack-tdx') return null;
    try {
      const q = await (await this.#dstack()).getQuote(sha512(payload));
      return q.quote.replace(/^0x/, '').toLowerCase();
    } catch (e) {
      logger.warn('per-payload dstack quote failed', { error: errMsg(e) });
      return null;
    }
  }

  reportBlock(): ReportAttestation {
    return { kind: this.state.kind, appId: this.state.appId, signer: this.state.signer, quoteDigest: this.state.quoteDigest, verifyUrl: this.state.verifyUrl };
  }
}

export function makeAttestor(vendor: TeeVendor, env: Record<string, string | undefined>, keys: ServiceKeys, chainId: number, market: Address | null): TeeAttestor {
  if (vendor === 'phala') return new PhalaAttestor(dstackEndpoint(env), keys, chainId, market);
  return new EigenAttestor(env, keys.account.address, keys.encPublicKey, keys.source, chainId, market, vendor);
}

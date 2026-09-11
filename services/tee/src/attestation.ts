/**
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

export interface AttestationState {
  kind: 'eigencompute-tdx' | 'none-local-dev';
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
}

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
  EIGEN_IMAGE_DIGEST?: string;
  EIGEN_VERIFY_URL?: string;
  EIGEN_ENVIRONMENT?: string; // mainnet-alpha | sepolia
  ATTEST_SOCKET_PATH?: string;
}

export class Attestor {
  state: AttestationState;
  #cfg: AttestConfig | null;
  constructor(
    private readonly env: AttestationEnv,
    signer: Address,
    encPubKey: Hex,
    keySource: string,
    chainId: number,
    market: Address | null,
  ) {
    const appId = env.EIGEN_APP_ID || null;
    const dash = env.EIGEN_ENVIRONMENT === 'sepolia' ? 'https://verify-sepolia.eigencloud.xyz' : 'https://verify.eigencloud.xyz';
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
      kind: 'none-local-dev',
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

  reportBlock(): { kind: AttestationState['kind']; appId: string | null; signer: Address; quoteDigest: string | null; verifyUrl: string | null } {
    return { kind: this.state.kind, appId: this.state.appId, signer: this.state.signer, quoteDigest: this.state.quoteDigest, verifyUrl: this.state.verifyUrl };
  }
}

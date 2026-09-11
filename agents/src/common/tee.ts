/** HTTP client for the TEE service (services/tee). Base URL from TEE_URL. */
import type { Address, Hex } from 'viem';
import { sha256Hex } from '@envmarket/shared';

export class TeeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface TeeHealth {
  signer: Address;
  encPubKey: Hex;
  chainId: number;
  market: Address | null;
  attestation: { kind: string; appId?: string | null; verifyUrl?: string | null; [k: string]: unknown };
  raw: Record<string, unknown>;
}

export function teeUrl(): string {
  return (process.env.TEE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

function strip0x(h: string): string {
  return h.startsWith('0x') ? h.slice(2) : h;
}

export class TeeClient {
  readonly base: string;
  constructor(base: string = teeUrl()) {
    this.base = base.replace(/\/+$/, '');
  }

  /** Base URL sellers put on-chain as `uri` (content-addressed public docs: `${uri}<64hex>`). */
  get blobBaseUrl(): string {
    return `${process.env.TEE_PUBLIC_URL?.replace(/\/+$/, '') ?? this.base}/blobs/`;
  }

  private async req(method: string, p: string, body?: unknown, raw = false): Promise<any> {
    const init: RequestInit = { method, headers: {} as Record<string, string>, signal: AbortSignal.timeout(Number(process.env.TEE_TIMEOUT_MS ?? 600_000)) };
    if (body instanceof Uint8Array) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/octet-stream';
      init.body = Buffer.from(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit;
    } else if (body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(this.base + p, init);
    } catch (e) {
      throw new TeeHttpError(`TEE ${method} ${p} failed: ${(e as Error).message} (is the TEE service running at ${this.base}?)`, 0, null);
    }
    if (raw) {
      if (!res.ok) throw new TeeHttpError(`TEE ${method} ${p} → HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`, res.status, null);
      return new Uint8Array(await res.arrayBuffer());
    }
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.error ?? data.message)) || String(text).slice(0, 400);
      throw new TeeHttpError(`TEE ${method} ${p} → HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status, data);
    }
    return data;
  }

  async health(): Promise<TeeHealth> {
    const h = (await this.req('GET', '/health')) as Record<string, any>;
    const encPubKey = h.encPubKey ?? h.x25519PublicKey ?? h.teeEncPubKey ?? h.attestation?.encPubKey;
    if (typeof encPubKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(encPubKey)) throw new Error('TEE /health did not return an X25519 encPubKey');
    return { signer: h.signer, encPubKey: encPubKey.toLowerCase() as Hex, chainId: Number(h.chainId), market: h.market ?? null, attestation: h.attestation ?? {}, raw: h };
  }

  attestation(): Promise<Record<string, any>> {
    return this.req('GET', '/attestation');
  }

  async putBlob(bytes: Uint8Array): Promise<Hex> {
    const r = await this.req('PUT', '/blobs', bytes);
    const got = String(r?.sha256 ?? r?.hash ?? '');
    const want = sha256Hex(bytes);
    if (`0x${strip0x(got).toLowerCase()}` !== want) throw new Error(`TEE blob store returned ${got}, expected ${want}`);
    return want;
  }

  /** Fetch a content-addressed blob and verify its sha256. `baseUrl` defaults to this TEE's /blobs/. */
  async getBlob(hash: Hex, baseUrl?: string): Promise<Uint8Array> {
    return fetchVerified(`${(baseUrl ?? this.blobBaseUrl).replace(/\/?$/, '/')}${strip0x(hash)}`, hash);
  }

  sellerUpload(body: unknown): Promise<any> {
    return this.req('POST', '/seller/upload', body);
  }

  /** Signed preview quote: {quote, quoteHash = sha256(canonicalJson(quote)), signature (EIP-191 over the raw hash)}. */
  previewQuote(versionId: bigint): Promise<any> {
    return this.req('GET', `/preview/quote/${versionId}`);
  }

  preview(versionId: bigint): Promise<any> {
    return this.req('POST', `/preview/${versionId}`);
  }

  report(versionId: bigint): Promise<any> {
    return this.req('GET', `/reports/${versionId}`);
  }

  delivery(purchaseId: bigint): Promise<any> {
    return this.req('GET', `/deliveries/${purchaseId}`);
  }

  evidenceUpload(body: unknown): Promise<any> {
    return this.req('POST', '/evidence-upload', body);
  }

  getRaw(p: string): Promise<Uint8Array> {
    return this.req('GET', p, undefined, true);
  }
}

/** GET a URL and require sha256(body) == expected. */
export async function fetchVerified(url: string, expected: Hex): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new Error(`fetch ${url} failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  const got = sha256Hex(b);
  if (got !== expected.toLowerCase()) throw new Error(`hash mismatch for ${url}: got ${got}, expected ${expected}`);
  return b;
}

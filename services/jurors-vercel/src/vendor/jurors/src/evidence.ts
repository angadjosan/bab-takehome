/**
 * Case-packet fetch from the TEE evidence server: POST /evidence/:disputeId with an EIP-191
 * signature (shared `evidenceAuthMessage`) from this seated juror's wallet. The packet is returned
 * as opaque untrusted data plus its sha256 (recorded with the decision).
 */
import { randomBytes } from 'node:crypto';
import { evidenceAuthMessage, signEvidenceAuth } from '@envmarket/shared';
import type { Address, Hex, LocalAccount } from 'viem';
import { sha256Hex } from './rubric.ts';

export const MAX_PACKET_BYTES = 4 * 1024 * 1024;
export const AUTH_TTL_SEC = 300;

export class EvidenceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'EvidenceError';
  }
}

export interface CasePacket {
  packet: unknown;
  /** Pretty JSON (or raw text) given to the model inside <case_packet>. */
  packetText: string;
  packetSha256: Hex;
  bytes: number;
}

export async function buildEvidenceAuth(a: { chainId: number; market: Address; disputeId: bigint; account: LocalAccount; nowSec?: number }) {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = (a.nowSec ?? Math.floor(Date.now() / 1000)) + AUTH_TTL_SEC;
  const message = evidenceAuthMessage({ chainId: a.chainId, market: a.market, disputeId: a.disputeId, juror: a.account.address, nonce, expiresAt });
  const signature = await signEvidenceAuth(a.account, message);
  return { juror: a.account.address, message, signature, nonce, expiresAt };
}

export async function fetchCasePacket(a: {
  teeUrl: string;
  chainId: number;
  market: Address;
  disputeId: bigint;
  account: LocalAccount;
  timeoutMs?: number;
}): Promise<CasePacket> {
  const auth = await buildEvidenceAuth(a);
  const url = `${a.teeUrl.replace(/\/+$/, '')}/evidence/${a.disputeId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(auth),
      signal: AbortSignal.timeout(a.timeoutMs ?? 60_000),
    });
  } catch (e) {
    throw new EvidenceError(`POST ${url} failed: ${(e as Error).message}`, null);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new EvidenceError(`POST ${url} -> HTTP ${res.status}: ${new TextDecoder().decode(buf.slice(0, 300))}`, res.status);
  if (buf.byteLength > MAX_PACKET_BYTES) throw new EvidenceError(`case packet too large (${buf.byteLength} bytes)`, res.status);
  const text = new TextDecoder().decode(buf);
  let packet: unknown = text;
  let packetText = text;
  try {
    packet = JSON.parse(text);
    packetText = JSON.stringify(packet, null, 2);
  } catch {
    /* non-JSON packet: passed through as text */
  }
  return { packet, packetText, packetSha256: sha256Hex(buf), bytes: buf.byteLength };
}

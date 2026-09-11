/**
 * Publish a screened rationale after this juror's reveal is confirmed (publishing earlier would
 * leak the vote during the commit phase). Written to `.data/rationales/<disputeId>-<juror>.json`
 * and, if a TEE URL is configured, PUT to its content-addressed blob store.
 */
import * as path from 'node:path';
import type { Address, Hex } from 'viem';
import { sha256Hex } from './rubric.ts';
import { writeFileAtomic, type Decision } from './state.ts';

export const RATIONALE_TYPE = 'envmarket.juror-rationale.v1';

/** Sorted-key JSON without whitespace (same convention as the shared canonicalJson). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

export interface RationaleDoc {
  type: typeof RATIONALE_TYPE;
  chainId: number;
  market: string;
  disputeId: string;
  round: number;
  juror: string;
  verdict: string;
  confidence: number;
  rationale: string;
  citedFacts: string[];
  screening: Decision['public']['screening'];
  model: Decision['model'];
  promptVersion: string;
  promptHash: string;
  packetSha256: string;
  commitment: string;
  revealTx: string;
  createdAt: string;
}

export function buildRationaleDoc(a: {
  chainId: number;
  market: Address;
  disputeId: bigint;
  round: number;
  juror: Address;
  decision: Decision;
  verdict: string;
  commitment: Hex;
  revealTx: Hex;
}): RationaleDoc {
  return {
    type: RATIONALE_TYPE,
    chainId: a.chainId,
    market: a.market.toLowerCase(),
    disputeId: a.disputeId.toString(),
    round: a.round,
    juror: a.juror.toLowerCase(),
    verdict: a.verdict,
    confidence: Math.round(a.decision.output.confidence * 100) / 100,
    rationale: a.decision.public.rationale,
    citedFacts: a.decision.public.citedFacts,
    screening: a.decision.public.screening,
    model: a.decision.model,
    promptVersion: a.decision.promptVersion,
    promptHash: a.decision.promptHash,
    packetSha256: a.decision.packetSha256,
    commitment: a.commitment,
    revealTx: a.revealTx,
    createdAt: new Date().toISOString(),
  };
}

export async function putBlob(teeUrl: string, bytes: Uint8Array): Promise<{ sha256: Hex; url: string }> {
  const res = await fetch(`${teeUrl.replace(/\/+$/, '')}/blobs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`PUT /blobs -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { sha256?: string };
  const expected = sha256Hex(bytes);
  if (!body.sha256 || body.sha256.toLowerCase() !== expected) throw new Error(`blob store returned sha256 ${body.sha256}, expected ${expected}`);
  return { sha256: expected, url: `${teeUrl.replace(/\/+$/, '')}/blobs/${expected}` };
}

export async function publishRationale(a: {
  dataDir: string;
  teeUrl?: string;
  doc: RationaleDoc;
  log: (line: string) => void;
}): Promise<{ file: string; sha256: Hex; blobUrl?: string }> {
  const text = canonical(a.doc);
  const bytes = new TextEncoder().encode(text);
  const sha256 = sha256Hex(bytes);
  const file = path.join(a.dataDir, 'rationales', `${a.doc.disputeId}-${a.doc.juror}.json`);
  writeFileAtomic(file, text);
  let blobUrl: string | undefined;
  if (a.teeUrl) {
    try {
      blobUrl = (await putBlob(a.teeUrl, bytes)).url;
    } catch (e) {
      a.log(`rationale blob upload failed (kept locally): ${(e as Error).message}`);
    }
  }
  a.log(`published rationale dispute ${a.doc.disputeId} round ${a.doc.round}: sha256 ${sha256}${blobUrl ? ` -> ${blobUrl}` : ''} (${file})`);
  return { file, sha256, blobUrl };
}

import type { Hex } from "viem";
import { TEE_URL } from "./config";
import { eqHash, sha256Hex } from "./crypto";
import type { RationaleDoc } from "./tee";

export type ListedRationale = { juror: string; round: number; sha256: Hex; url: string; doc: RationaleDoc; hashOk: boolean };

/**
 * GET /rationales/:disputeId — screened juror rationales the TEE has indexed, served only once each
 * juror's reveal is on-chain. The hash of each text is re-checked here; the caller checks the seat,
 * vote and commitment against the chain.
 */
export async function listRationales(disputeId: bigint): Promise<ListedRationale[]> {
  const res = await fetch(`${TEE_URL}/rationales/${disputeId}`, { cache: "no-store" });
  if (res.status === 404) return []; // a TEE build without the endpoint
  if (!res.ok) throw new Error(`/rationales/${disputeId} → HTTP ${res.status}`);
  const body = (await res.json()) as { rationales?: { juror: string; round: number; sha256: Hex; url: string; docJson: string | null }[] };
  return (body.rationales ?? [])
    .filter((r) => typeof r.docJson === "string")
    .map((r) => ({ juror: r.juror, round: r.round, sha256: r.sha256, url: r.url, doc: JSON.parse(r.docJson!) as RationaleDoc, hashOk: eqHash(sha256Hex(r.docJson!), r.sha256) }));
}

import type { Hex } from "viem";
import { CHAIN_ID, TEE_URL } from "./config";
import { base64ToBytes, canonicalJson, sha256Hex, utf8 } from "./crypto";

/** Client for the TEE service HTTP API (docs/BUILD_SPEC.md "TEE service HTTP API"). */

export class TeeError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

function url(path: string) {
  if (!TEE_URL) throw new TeeError("NEXT_PUBLIC_TEE_URL is not configured");
  return `${TEE_URL}${path}`;
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path), { cache: "no-store" });
  } catch (e) {
    throw new TeeError(`TEE service unreachable (${(e as Error).message})`);
  }
  if (!res.ok) throw new TeeError(`${path} → HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

export type Health = { signer?: string; attestation?: unknown; chainId?: number; market?: string } & Record<string, unknown>;
export const getHealth = () => getJson<Health>("/health");
export const getAttestation = () => getJson<Record<string, unknown>>("/attestation");

export type ModelResult = {
  requested: string;
  resolved?: string;
  provider?: string;
  status: "run" | "unavailable" | string;
  purchased?: { attempted: number; solved: number; pass1Rounded: number | null };
  audit?: { attempted: number; solved: number; pass1Rounded: number | null };
  infraFailures?: number;
  note?: string;
};

export type PreviewReport = {
  type: string;
  versionId: string | number;
  environmentVersion?: string;
  bundleHash: Hex;
  ciphertextHash?: Hex;
  taskRoot?: Hex;
  auditRoot?: Hex;
  protocol?: {
    id?: string;
    harnessDigest?: string;
    promptDigest?: string;
    decoding?: { temperature?: number; seed?: number; maxTokens?: number };
    actionBudget?: number;
    timeBudgetSec?: number;
    successRule?: string;
  } & Record<string, unknown>;
  models?: ModelResult[];
  uncertainty?: string;
  validator?: {
    model?: string;
    promptVersion?: string;
    promptHash?: string;
    explanation?: string | Record<string, unknown>;
    screening?: { passed: boolean; reasons?: string[] };
  } & Record<string, unknown>;
  jobs?: { jobId: string; startedAt?: string | number; finishedAt?: string | number; status: string; note?: string }[];
  runtime?: { imageDigest?: string; sandbox?: string; network?: string } & Record<string, unknown>;
  attestation?: { kind?: string; appId?: string; signer?: string; quoteDigest?: string; verifyUrl?: string } & Record<string, unknown>;
  signer?: string;
  createdAt?: string | number;
} & Record<string, unknown>;

export type SignedReport = {
  report: PreviewReport;
  /** sha256 of canonical report JSON, computed in the browser */
  computedHash: Hex;
  /** hash the service claims */
  claimedHash?: Hex;
  signature?: Hex;
};

export async function getSignedReport(versionId: bigint | number): Promise<SignedReport> {
  const raw = await getJson<Record<string, unknown>>(`/reports/${versionId}`);
  const inner = (raw.report ?? raw) as PreviewReport | string;
  let report: PreviewReport;
  let computedHash: Hex;
  if (typeof inner === "string") {
    report = JSON.parse(inner);
    computedHash = sha256Hex(inner);
  } else {
    report = inner;
    computedHash = sha256Hex(canonicalJson(inner));
  }
  return {
    report,
    computedHash,
    claimedHash: (raw.reportHash as Hex) ?? undefined,
    signature: ((raw.signature ?? raw.runnerSig ?? raw.sig) as Hex) ?? undefined,
  };
}

/**
 * Fetch a content-addressed public document (description.json, manifest.json, report.json...)
 * from the version's `uri` base (e.g. https://<tee-host>/blobs/). Returns raw bytes so the
 * caller can check sha256 against the on-chain commitment.
 */
export async function fetchBlob(uriBase: string, hash: Hex): Promise<{ bytes: Uint8Array; url: string }> {
  const bases = [uriBase, TEE_URL ? `${TEE_URL}/blobs/` : ""].filter(Boolean);
  const noPrefix = hash.replace(/^0x/, "");
  const tried: string[] = [];
  for (const b of bases) {
    const baseUrl = b.endsWith("/") ? b : `${b}/`;
    for (const h of [noPrefix, hash]) {
      const u = `${baseUrl}${h}`;
      if (tried.includes(u)) continue;
      tried.push(u);
      try {
        const res = await fetch(u, { cache: "force-cache" });
        if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), url: u };
      } catch {
        /* try next */
      }
    }
  }
  throw new TeeError(`Document ${noPrefix.slice(0, 10)}… not found at ${bases.join(" or ") || "(no uri)"}`);
}

export async function fetchUrlBytes(u: string): Promise<Uint8Array> {
  const res = await fetch(u, { cache: "no-store" });
  if (!res.ok) throw new TeeError(`${u} → HTTP ${res.status}`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export type DeliveryPackage = {
  wrapperBytes: Uint8Array;
  wrapper: Record<string, unknown>;
  wrappedKey: Uint8Array;
  ciphertextUrl: string;
};

export async function getDelivery(purchaseId: bigint | number): Promise<DeliveryPackage> {
  const raw = await getJson<Record<string, unknown>>(`/deliveries/${purchaseId}`);
  const w = raw.wrapper;
  const wrapperStr = typeof w === "string" ? w : canonicalJson(w);
  const ct = String(raw.ciphertextUrl ?? "");
  const ciphertextUrl = /^https?:\/\//.test(ct) ? ct : `${TEE_URL}${ct.startsWith("/") ? "" : "/"}${ct}`;
  return {
    wrapperBytes: utf8(wrapperStr),
    wrapper: typeof w === "string" ? JSON.parse(w) : (w as Record<string, unknown>),
    wrappedKey: base64ToBytes(String(raw.wrappedKey ?? "")),
    ciphertextUrl,
  };
}

/**
 * Send dispute evidence privately to the TEE (it builds the reviewers' case packet). Evidence is
 * never put in the public blob store: it may describe purchased task content.
 */
export async function uploadEvidence(a: { disputeId: bigint; purchaseId: bigint; evidenceHash: Hex; text: string }): Promise<boolean> {
  try {
    const res = await fetch(url("/evidence-upload"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disputeId: a.disputeId.toString(), purchaseId: a.purchaseId.toString(), evidenceHash: a.evidenceHash, evidence: a.text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const evKey = (id: bigint | string) => `envmarket.evidence.${CHAIN_ID}.${id}`;
export function saveLocalEvidence(disputeId: bigint, text: string) {
  try {
    window.localStorage.setItem(evKey(disputeId), text);
  } catch {
    /* storage blocked */
  }
}
export function loadLocalEvidence(disputeId: bigint): string | null {
  try {
    return window.localStorage.getItem(evKey(disputeId));
  } catch {
    return null;
  }
}

export async function putBlob(bytes: Uint8Array): Promise<string | null> {
  try {
    const res = await fetch(url("/blobs"), { method: "PUT", body: bytes as BodyInit, headers: { "content-type": "application/octet-stream" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { sha256?: string };
    return j.sha256 ?? null;
  } catch {
    return null;
  }
}

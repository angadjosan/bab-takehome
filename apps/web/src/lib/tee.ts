import { recoverMessageAddress, type Address, type Hex } from "viem";
import { CHAIN_ID, deployment, TEE_URL, TEE_VIA_PROXY } from "./config";
import { base64ToBytes, canonicalJson, eqHash, sha256Hex, utf8 } from "./crypto";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Client for the TEE service HTTP API. Shapes follow services/tee/src/server.ts (the source of
 * truth) and packages/shared/src/report.ts (report schema). Every document that has an on-chain
 * commitment is hash-checked by the caller or here.
 */

export class TeeError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

function url(path: string) {
  if (!TEE_URL) throw new TeeError("NEXT_PUBLIC_TEE_URL is not configured");
  return `${TEE_URL}${path}`;
}

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url(path), { cache: "no-store", ...init });
  } catch (e) {
    throw new TeeError(`TEE service unreachable at ${TEE_URL} (${(e as Error).message})`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, body };
}

function errText(path: string, status: number, body: unknown) {
  const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : typeof body === "string" ? body.slice(0, 200) : "";
  return `${path} → HTTP ${status}${msg ? `: ${msg}` : ""}`;
}

async function getJson<T>(path: string): Promise<T> {
  const { status, body } = await request(path);
  if (status < 200 || status >= 300) throw new TeeError(errText(path, status, body), status, body);
  return body as T;
}

/* ------------------------------------ health ------------------------------------ */

export type Health = {
  ok: boolean;
  service: string;
  signer: Address;
  encPubKey: Hex;
  keySource: string;
  chainId: number;
  market: Address | null;
  attestation: { kind: string; appId: string | null; imageDigest: string | null; verifyUrl: string | null; quoteDigest: string | null; encPubKey: Hex };
  sandbox: unknown;
  inference: { provider: string; baseUrl: string; keyConfigured: boolean };
  submitTxs: boolean;
  watcher: unknown;
};
export const getHealth = () => getJson<Health>("/health");

/** GET /attestation → the attestor state plus the signer's on-chain roles. */
export type Attestation = { kind?: string; appId?: string | null; verifyUrl?: string | null; quoteDigest?: string | null; signerRoles?: Record<string, boolean | string> | null } & Record<string, unknown>;
export const getAttestation = () => getJson<Attestation>("/attestation");

/* ------------------------------ preview report (strict) ------------------------------ */

export type Outcome = { attempted: number; solved: number; pass1Rounded: number | null };
export type ModelResult = {
  requested: string;
  resolved: string | null;
  provider: string | null;
  status: "run" | "unavailable";
  purchased: Outcome;
  audit: Outcome;
  infraFailures: number;
};
export type JobStatus = "scheduled" | "running" | "succeeded" | "failed" | "infra_failure" | "superseded" | "cancelled";

/** envmarket.report.v1 exactly as packages/shared reportSchema defines it (strict: no extra keys). */
export type PreviewReport = {
  type: "envmarket.report.v1";
  versionId: string;
  environmentVersion: string;
  bundleHash: Hex;
  ciphertextHash: Hex;
  taskRoot: Hex;
  auditRoot: Hex;
  protocol: {
    id: string;
    harnessDigest: Hex;
    promptDigest: Hex;
    decoding: { temperature: number; seed: number; maxTokens: number };
    actionBudget: number;
    timeBudgetSec: number;
    successRule: string;
  };
  models: ModelResult[];
  uncertainty: string;
  validator: { model: string; promptVersion: string; promptHash: Hex; explanation: string; screening: { passed: boolean; reasons: string[] } };
  jobs: { jobId: string; startedAt: string; finishedAt: string | null; status: JobStatus }[];
  runtime: { imageDigest: Hex; sandbox: string; network: "none" };
  attestation: { kind: "eigencompute-tdx" | "none-local-dev"; appId: string | null; signer: Address; quoteDigest: string | null; verifyUrl: string | null };
  signer: Address;
  createdAt: string;
};

const KEYS: Record<string, string[]> = {
  report: ["type", "versionId", "environmentVersion", "bundleHash", "ciphertextHash", "taskRoot", "auditRoot", "protocol", "models", "uncertainty", "validator", "jobs", "runtime", "attestation", "signer", "createdAt"],
  protocol: ["id", "harnessDigest", "promptDigest", "decoding", "actionBudget", "timeBudgetSec", "successRule"],
  model: ["requested", "resolved", "provider", "status", "purchased", "audit", "infraFailures"],
  outcome: ["attempted", "solved", "pass1Rounded"],
  validator: ["model", "promptVersion", "promptHash", "explanation", "screening"],
  job: ["jobId", "startedAt", "finishedAt", "status"],
  runtime: ["imageDigest", "sandbox", "network"],
  attestation: ["kind", "appId", "signer", "quoteDigest", "verifyUrl"],
};
const JOB_STATUSES = ["scheduled", "running", "succeeded", "failed", "infra_failure", "superseded", "cancelled"];
const B32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** pass1Rounded as the shared lib computes it: nearest multiple of 5 of 100·s/a (half up), null when a = 0. */
export function expectedPass1(solved: number, attempted: number): number | null {
  if (attempted === 0) return null;
  return Math.floor((40 * solved + attempted) / (2 * attempted)) * 5;
}

/**
 * Structural check mirroring reportSchema (the web app does not import packages/shared). Returns
 * a list of problems; empty means the document has exactly the committed shape.
 */
export function checkReportSchema(r: unknown): string[] {
  const out: string[] = [];
  const obj = (v: unknown, name: string, keys: string[]) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      out.push(`${name} is not an object`);
      return false;
    }
    const have = Object.keys(v);
    const extra = have.filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !have.includes(k));
    if (extra.length) out.push(`${name} has unknown keys: ${extra.join(", ")}`);
    if (missing.length) out.push(`${name} is missing: ${missing.join(", ")}`);
    return true;
  };
  if (!obj(r, "report", KEYS.report)) return out;
  const x = r as PreviewReport;
  if (x.type !== "envmarket.report.v1") out.push(`type is ${String(x.type)}`);
  if (!/^[0-9]+$/.test(String(x.versionId))) out.push("versionId is not a decimal string");
  for (const k of ["bundleHash", "ciphertextHash", "taskRoot", "auditRoot"] as const) if (!B32.test(String(x[k]))) out.push(`${k} is not a lowercase bytes32`);
  if (obj(x.protocol, "protocol", KEYS.protocol)) {
    if (!B32.test(String(x.protocol.harnessDigest))) out.push("protocol.harnessDigest is not bytes32");
    if (!B32.test(String(x.protocol.promptDigest))) out.push("protocol.promptDigest is not bytes32");
  }
  if (!Array.isArray(x.models) || x.models.length === 0) out.push("models is empty");
  else
    x.models.forEach((m, i) => {
      if (!obj(m, `models[${i}]`, KEYS.model)) return;
      if (m.status !== "run" && m.status !== "unavailable") out.push(`models[${i}].status is ${String(m.status)}`);
      for (const part of ["purchased", "audit"] as const) {
        const o = m[part];
        if (!obj(o, `models[${i}].${part}`, KEYS.outcome)) continue;
        if (o.solved > o.attempted) out.push(`models[${i}].${part}: solved > attempted`);
        if (o.pass1Rounded !== expectedPass1(o.solved, o.attempted)) out.push(`models[${i}].${part}.pass1Rounded ${o.pass1Rounded} ≠ rounded ${o.solved}/${o.attempted}`);
      }
    });
  if (obj(x.validator, "validator", KEYS.validator)) {
    if (typeof x.validator.explanation !== "string") out.push("validator.explanation is not a string");
    else {
      const words = x.validator.explanation.trim() ? x.validator.explanation.trim().split(/\s+/).length : 0;
      if (words > 120 || utf8(x.validator.explanation).length > 1000) out.push("validator.explanation exceeds 120 words / 1000 bytes");
    }
  }
  if (!Array.isArray(x.jobs)) out.push("jobs is not an array");
  else x.jobs.forEach((j, i) => obj(j, `jobs[${i}]`, KEYS.job) && !JOB_STATUSES.includes(j.status) && out.push(`jobs[${i}].status is ${String(j.status)}`));
  if (obj(x.runtime, "runtime", KEYS.runtime) && x.runtime.network !== "none") out.push(`runtime.network is ${String(x.runtime.network)}`);
  if (obj(x.attestation, "attestation", KEYS.attestation)) {
    if (x.attestation.kind !== "eigencompute-tdx" && x.attestation.kind !== "none-local-dev") out.push(`attestation.kind is ${String(x.attestation.kind)}`);
    if (!ADDR.test(String(x.attestation.signer))) out.push("attestation.signer is not an address");
  }
  if (!ADDR.test(String(x.signer))) out.push("signer is not an address");
  return out;
}

export type SignedReport = {
  report: PreviewReport;
  /** the exact canonical bytes the service hashed and signed */
  reportJson: string;
  /** sha256(reportJson), computed in the browser */
  computedHash: Hex;
  /** canonicalJson(report) === reportJson (the parsed object and the signed bytes agree) */
  canonical: boolean;
  claimedHash: Hex | null;
  signature: Hex | null;
  signer: Address | null;
  attachTx: Hex | null;
  disclosures: unknown;
  schemaProblems: string[];
};

/** Report state for a version on the TEE: 200 signed report, 202 running, 500 failed, 404 none. */
export type ReportState = { state: "ready"; signed: SignedReport } | { state: "running"; startedAt?: string } | { state: "failed"; error: string } | { state: "none" };

function toSigned(raw: Record<string, unknown>): SignedReport {
  const reportJson = typeof raw.reportJson === "string" ? raw.reportJson : canonicalJson(raw.report);
  const report = JSON.parse(reportJson) as PreviewReport;
  return {
    report,
    reportJson,
    computedHash: sha256Hex(reportJson),
    canonical: canonicalJson(report) === reportJson,
    claimedHash: (raw.reportHash as Hex) ?? null,
    signature: (raw.signature as Hex | null) ?? null,
    signer: (raw.signer as Address | null) ?? null,
    attachTx: (raw.attachTx as Hex | null) ?? null,
    disclosures: raw.disclosures ?? null,
    schemaProblems: checkReportSchema(report),
  };
}

export async function getReportState(versionId: bigint | number): Promise<ReportState> {
  const path = `/reports/${versionId}`;
  const { status, body } = await request(path);
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) return { state: "ready", signed: toSigned(b) };
  if (status === 202) return { state: "running", startedAt: b.startedAt as string | undefined };
  if (status === 404) return { state: "none" };
  if (status === 500 && b.status === "failed") return { state: "failed", error: String(b.error ?? "preview failed") };
  throw new TeeError(errText(path, status, body), status, body);
}

/* ------------------------------ preview quote + run ------------------------------ */

export type PreviewQuote = {
  quote: {
    type: string;
    versionId: string;
    cached: boolean;
    episodes: number;
    models: string[];
    validatorModel: string;
    estimatedCostUsd: number;
    feeUsdc: string;
    feeDecimals: number;
    costModel: string;
    issuedAt: number;
    validUntil: number;
    signer: string;
  } & Record<string, unknown>;
  quoteHash: Hex;
  signature: Hex;
  /** sha256(canonicalJson(quote)) === quoteHash */
  hashOk: boolean;
  /** EIP-191 signer of quoteHash, recovered here */
  signer: Address | null;
};

/** GET /preview/quote/:versionId — the TEE's signed fee quote; pay it with requestPreview(versionId, fee, quoteHash). */
export async function getPreviewQuote(versionId: bigint): Promise<PreviewQuote> {
  const b = await getJson<Omit<PreviewQuote, "hashOk" | "signer">>(`/preview/quote/${versionId}`);
  let signer: Address | null = null;
  try {
    signer = await recoverMessageAddress({ message: { raw: b.quoteHash }, signature: b.signature });
  } catch {
    signer = null;
  }
  return { ...b, hashOk: eqHash(sha256Hex(canonicalJson(b.quote)), b.quoteHash), signer };
}

/** POST /preview/:versionId?async=1 — starts the run (202) or returns the cached report (200). Needs a paid request on-chain. */
export async function startPreview(versionId: bigint): Promise<"running" | "cached"> {
  const path = `/preview/${versionId}?async=1`;
  const { status, body } = await request(path, { method: "POST" });
  if (status === 202) return "running";
  if (status === 200) return "cached";
  throw new TeeError(errText(path, status, body), status, body);
}

/** A report document fetched by its on-chain hash from the public blob store. */
export async function getReportBlob(uri: string, reportHash: Hex): Promise<SignedReport> {
  const { bytes } = await fetchBlob(uri, reportHash);
  const reportJson = new TextDecoder().decode(bytes);
  return toSigned({ reportJson, reportHash });
}

/* ------------------------------------ blobs ------------------------------------ */

/**
 * Fetch a content-addressed public document (description.json, manifest.json, report.json, findings,
 * juror rationales...) from the version's `uri` base (the TEE's `<publicUrl>/blobs/`), falling back
 * to this app's TEE. Returns raw bytes; callers check sha256 against the on-chain commitment.
 */
/** A plain-http URL can't be fetched from an https page (mixed content); those go through /api/tee. */
function reachable(u: string): boolean {
  if (typeof window === "undefined") return true;
  return !(window.location.protocol === "https:" && u.startsWith("http://"));
}

/** Route a TEE blob URL (e.g. the on-chain uri or a delivery's ciphertextUrl) through TEE_URL when it isn't reachable directly. */
export function blobUrlViaTee(u: string): string {
  if (reachable(u) && !TEE_VIA_PROXY) return u;
  const m = u.match(/\/blobs\/(?:0x)?([0-9a-fA-F]{64})$/);
  return m ? `${TEE_URL}/blobs/${m[1].toLowerCase()}` : u;
}

export async function fetchBlob(uriBase: string, hash: Hex): Promise<{ bytes: Uint8Array; url: string }> {
  const bases = [...new Set([uriBase, `${TEE_URL}/blobs/`].filter((b) => !!b && reachable(b)).map((b) => (b.endsWith("/") ? b : `${b}/`)))];
  const hex = hash.replace(/^0x/, "").toLowerCase();
  const errors: string[] = [];
  for (const b of bases) {
    const u = `${b}${hex}`;
    try {
      const res = await fetch(u, { cache: "force-cache" });
      if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), url: u };
      errors.push(`${u} → HTTP ${res.status}`);
    } catch (e) {
      errors.push(`${u} → ${(e as Error).message}`);
    }
  }
  throw new TeeError(`Document ${hex.slice(0, 10)}… not available (${errors.join("; ") || "no uri"})`);
}

export async function fetchUrlBytes(u: string): Promise<Uint8Array> {
  const res = await fetch(u, { cache: "no-store" });
  if (!res.ok) throw new TeeError(`${u} → HTTP ${res.status}`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** PUT /blobs (raw bytes) → {sha256, bytes, url}. Returns the hash after checking it. */
export async function putBlob(bytes: Uint8Array): Promise<Hex> {
  const { status, body } = await request("/blobs", { method: "PUT", body: bytes as BodyInit, headers: { "content-type": "application/octet-stream" } });
  if (status !== 200) throw new TeeError(errText("/blobs", status, body), status, body);
  const got = String((body as { sha256?: string }).sha256 ?? "");
  const want = sha256Hex(bytes);
  if (!eqHash(got, want)) throw new TeeError(`blob store returned ${got}, expected ${want}`);
  return want;
}

/* ----------------------------------- deliveries ----------------------------------- */

export type DeliveryPackage = {
  wrapperBytes: Uint8Array;
  wrapper: Record<string, unknown>;
  wrapperHash: Hex;
  wrappedKey: Uint8Array;
  wrappedKeyHash: Hex;
  ciphertextUrl: string;
  relay: Address;
  deliveredTx: Hex | null;
};

/** GET /deliveries/:id — 404 before the relay prepared it, 409 until Delivered on-chain. */
export async function getDelivery(purchaseId: bigint | number): Promise<DeliveryPackage> {
  const raw = await getJson<Record<string, unknown>>(`/deliveries/${purchaseId}`);
  const wrapperStr = typeof raw.wrapper === "string" ? raw.wrapper : canonicalJson(raw.wrapper);
  const ct = String(raw.ciphertextUrl ?? "");
  const ciphertextUrl = /^https?:\/\//.test(ct) ? blobUrlViaTee(ct) : `${TEE_URL}${ct.startsWith("/") ? "" : "/"}${ct}`;
  return {
    wrapperBytes: utf8(wrapperStr),
    wrapper: JSON.parse(wrapperStr),
    wrapperHash: raw.wrapperHash as Hex,
    wrappedKey: base64ToBytes(String(raw.wrappedKey ?? "")),
    wrappedKeyHash: raw.wrappedKeyHash as Hex,
    ciphertextUrl,
    relay: raw.relay as Address,
    deliveredTx: (raw.deliveredTx as Hex | null) ?? null,
  };
}

/* ------------------------------------ evidence ------------------------------------ */

/**
 * POST /evidence-upload BEFORE openDispute. The service stores the exact bytes privately (never in
 * the public blob store) and returns evidenceHash = sha256(bytes), which goes on-chain. Text is sent
 * as {content} (stored as UTF-8), files as {base64} (stored raw). The returned hash is checked
 * against the locally computed one so the on-chain commitment always matches what reviewers get.
 */
export async function uploadEvidence(e: { text: string } | { bytes: Uint8Array }): Promise<{ evidenceHash: Hex; bytes: number }> {
  const bytes = "text" in e ? utf8(e.text) : e.bytes;
  const payload = "text" in e ? { content: e.text } : { base64: bytesToBase64(e.bytes) };
  const { status, body } = await request("/evidence-upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (status !== 200) throw new TeeError(errText("/evidence-upload", status, body), status, body);
  const got = (body as { evidenceHash?: Hex }).evidenceHash;
  const want = sha256Hex(bytes);
  if (!eqHash(got, want)) throw new TeeError(`TEE stored evidence with hash ${got}, expected ${want}`);
  return { evidenceHash: want, bytes: bytes.length };
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

/* ------------------------------ juror case packet (EIP-191) ------------------------------ */

/** Same text as packages/shared evidenceAuthMessage. */
export function evidenceAuthMessage(a: { disputeId: bigint; juror: Address; nonce: string; expiresAt: number }): string {
  if (!deployment) throw new Error("not deployed");
  return [
    "EnvMarket evidence access",
    `chainId: ${CHAIN_ID}`,
    `market: ${deployment.market.toLowerCase()}`,
    `disputeId: ${a.disputeId.toString()}`,
    `juror: ${a.juror.toLowerCase()}`,
    `nonce: ${a.nonce}`,
    `expiresAt: ${a.expiresAt}`,
  ].join("\n");
}

export type CasePacket = { packet: Record<string, unknown>; packetHash: Hex; packetSignature: Hex; hashOk: boolean; packetSigner: Address | null };

/**
 * POST /evidence/:disputeId with a wallet-signed challenge. Only a juror seated on the dispute's
 * current round gets the packet. The packet's sha256 and the TEE's EIP-191 signature over it are
 * checked here.
 */
export async function requestCasePacket(a: { disputeId: bigint; juror: Address; signMessage: (message: string) => Promise<Hex> }): Promise<CasePacket> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const message = evidenceAuthMessage({ disputeId: a.disputeId, juror: a.juror, nonce, expiresAt });
  const signature = await a.signMessage(message);
  const path = `/evidence/${a.disputeId}`;
  const { status, body } = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ juror: a.juror, message, signature, nonce, expiresAt }) });
  if (status !== 200) throw new TeeError(errText(path, status, body), status, body);
  const b = body as { packet: Record<string, unknown>; packetHash: Hex; packetSignature: Hex };
  const hashOk = eqHash(sha256Hex(canonicalJson(b.packet)), b.packetHash);
  let packetSigner: Address | null = null;
  try {
    packetSigner = await recoverMessageAddress({ message: { raw: b.packetHash }, signature: b.packetSignature });
  } catch {
    packetSigner = null;
  }
  return { ...b, hashOk, packetSigner };
}

/* ------------------------------------ findings ------------------------------------ */

export type Findings = {
  findings: Record<string, unknown>;
  findingsHash: Hex;
  upheld: boolean;
  confirmedMask: string;
  signature: Hex;
  tx: Hex | null;
  /** sha256(canonicalJson(findings)) computed in the browser */
  computedHash: Hex;
};

/** GET /findings/:disputeId — public mechanical-verifier findings; findingsHash is on-chain. */
export async function getFindings(disputeId: bigint): Promise<Findings | null> {
  const path = `/findings/${disputeId}`;
  const { status, body } = await request(path);
  if (status === 404) return null;
  if (status !== 200) throw new TeeError(errText(path, status, body), status, body);
  const b = body as Omit<Findings, "computedHash">;
  return { ...b, computedHash: sha256Hex(canonicalJson(b.findings)) };
}

/* --------------------------------- juror rationales --------------------------------- */

/** services/jurors publish.ts RationaleDoc (canonical JSON, PUT to the TEE blob store after reveal). */
export type RationaleDoc = {
  type: "envmarket.juror-rationale.v1";
  chainId: number;
  market: string;
  disputeId: string;
  round: number;
  juror: string;
  verdict: string;
  confidence: number;
  rationale: string;
  citedFacts: string[];
  screening: unknown;
  model: { provider?: string; requested?: string; resolved?: string } & Record<string, unknown>;
  promptVersion: string;
  promptHash: string;
  packetSha256: string;
  commitment: string;
  revealTx: string;
  createdAt: string;
};

export async function fetchRationale(hash: Hex): Promise<{ doc: RationaleDoc; url: string; hashOk: boolean }> {
  const { bytes, url: u } = await fetchBlob("", hash);
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as RationaleDoc;
  if (doc?.type !== "envmarket.juror-rationale.v1") throw new TeeError(`blob ${hash.slice(0, 10)}… is not a juror rationale (type ${String(doc?.type)})`);
  return { doc, url: u, hashOk: eqHash(sha256Hex(bytes), hash) };
}

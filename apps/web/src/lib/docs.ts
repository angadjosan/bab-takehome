"use client";

import { useQuery } from "@tanstack/react-query";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { CHAIN_ID, deployment, TEE_URL } from "./config";
import { eqHash, sha256Hex } from "./crypto";
import { fetchBlob, getAttestation, getHealth, getSignedReport, type PreviewReport } from "./tee";
import { fetchIsRunner, isZeroHash, useMarketEvents, type Version } from "./market";

/* ------------------------- hash-verified public documents ------------------------- */

export type VerifiedDoc = {
  url: string;
  bytes: Uint8Array;
  text: string;
  json: Record<string, unknown> | null;
  computed: Hex;
  ok: boolean;
};

export function useDoc(uri: string | undefined, hash: Hex | undefined) {
  return useQuery({
    queryKey: ["doc", uri, hash],
    enabled: !!hash && !isZeroHash(hash) && (!!uri || !!TEE_URL),
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<VerifiedDoc> => {
      const { bytes, url } = await fetchBlob(uri ?? "", hash!);
      const computed = sha256Hex(bytes);
      const text = new TextDecoder().decode(bytes);
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { url, bytes, text, json, computed, ok: eqHash(computed, hash) };
    },
  });
}

/* ------------------------------- description helpers ------------------------------ */

export type Claim = { id: string; text: string; category?: string };

export function describe(json: Record<string, unknown> | null | undefined) {
  const j = json ?? {};
  const s = (k: string[]) => {
    for (const x of k) if (typeof j[x] === "string" && j[x]) return j[x] as string;
    return undefined;
  };
  const arr = (k: string[]) => {
    for (const x of k) if (Array.isArray(j[x])) return j[x] as unknown[];
    return [];
  };
  const claims: Claim[] = arr(["claims"]).map((c, i) =>
    typeof c === "string"
      ? { id: String(i + 1), text: c }
      : {
          id: String((c as Record<string, unknown>).id ?? (c as Record<string, unknown>).number ?? i + 1),
          text: String((c as Record<string, unknown>).text ?? (c as Record<string, unknown>).claim ?? JSON.stringify(c)),
          category: typeof (c as Record<string, unknown>).category === "string" ? String((c as Record<string, unknown>).category) : undefined,
        },
  );
  const skills = arr(["skills", "targetSkills", "skillTags", "tags"]).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).name ?? x)));
  return {
    title: s(["title", "name"]),
    summary: s(["summary", "tagline", "shortDescription", "description"]),
    environmentType: s(["environmentType", "type"]),
    environmentVersion: s(["environmentVersion", "version"]),
    skills,
    claims,
    raw: j,
  };
}

/* ------------------------------ signed preview report ------------------------------ */

export type ReportVerification = {
  report: PreviewReport;
  source: "tee" | "blob";
  computedHash: Hex;
  hashMatchesChain: boolean;
  bundleMatches: boolean;
  signature?: Hex;
  recoveredSigner?: Address;
  signatureValid?: boolean;
  signerIsRunner?: boolean;
  onchainRunner?: Address;
  healthSigner?: string;
};

export function useVerifiedReport(version: Version | undefined) {
  const events = useMarketEvents();
  const attachEvent = events.data?.find((e) => e.eventName === "ReportAttached" && String(e.args.versionId) === version?.id.toString());
  return useQuery({
    queryKey: ["report", version?.id.toString(), version?.reportHash],
    enabled: !!version && !isZeroHash(version.reportHash),
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<ReportVerification> => {
      const v = version!;
      let report: PreviewReport;
      let computedHash: Hex;
      let signature: Hex | undefined;
      let source: "tee" | "blob" = "tee";
      try {
        const signed = await getSignedReport(v.id);
        report = signed.report;
        computedHash = signed.computedHash;
        signature = signed.signature;
      } catch {
        const blob = await fetchBlob(v.uri, v.reportHash);
        computedHash = sha256Hex(blob.bytes);
        report = JSON.parse(new TextDecoder().decode(blob.bytes));
        source = "blob";
      }
      let recoveredSigner: Address | undefined;
      let signatureValid: boolean | undefined;
      let signerIsRunner: boolean | undefined;
      if (signature && deployment) {
        try {
          recoveredSigner = await recoverTypedDataAddress({
            domain: { name: "EnvMarket", version: "1", chainId: CHAIN_ID, verifyingContract: deployment.market },
            types: {
              PreviewReport: [
                { name: "versionId", type: "uint256" },
                { name: "bundleHash", type: "bytes32" },
                { name: "reportHash", type: "bytes32" },
              ],
            },
            primaryType: "PreviewReport",
            message: { versionId: v.id, bundleHash: v.bundleHash, reportHash: v.reportHash },
            signature,
          });
          signatureValid = !report.signer || eqHash(recoveredSigner, report.signer);
          signerIsRunner = await fetchIsRunner(recoveredSigner);
        } catch {
          signatureValid = false;
        }
      }
      let healthSigner: string | undefined;
      try {
        healthSigner = (await getHealth()).signer;
      } catch {
        /* optional */
      }
      return {
        report,
        source,
        computedHash,
        hashMatchesChain: eqHash(computedHash, v.reportHash),
        bundleMatches: eqHash(report.bundleHash, v.bundleHash),
        signature,
        recoveredSigner,
        signatureValid,
        signerIsRunner,
        onchainRunner: attachEvent?.args.runner as Address | undefined,
        healthSigner,
      };
    },
  });
}

export function useAttestation() {
  return useQuery({ queryKey: ["attestation"], queryFn: getAttestation, enabled: !!TEE_URL, staleTime: 5 * 60_000, retry: 0 });
}
export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: getHealth, enabled: !!TEE_URL, staleTime: 60_000, retry: 0 });
}

/** pass@1 may be given as a fraction (0.4) or percent (40). Always render as integer percent. */
export function fmtPass(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const pctv = v <= 1 ? v * 100 : v;
  return `${Math.round(pctv)}%`;
}

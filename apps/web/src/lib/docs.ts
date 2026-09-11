"use client";

import { useQuery } from "@tanstack/react-query";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { CHAIN_ID, deployment, TEE_URL } from "./config";
import { eqHash, sha256Hex } from "./crypto";
import { fetchBlob, getAttestation, getHealth, getReportBlob, getReportState, type PreviewReport, type SignedReport } from "./tee";
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

export type Claim = { id: string; text: string; category?: string; check?: string };

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
  const claims: Claim[] = arr(["claims"]).map((c, i) => {
    if (typeof c === "string") return { id: `C${i + 1}`, text: c };
    const o = c as Record<string, unknown>;
    return {
      id: String(o.id ?? o.number ?? `C${i + 1}`),
      text: String(o.text ?? o.claim ?? JSON.stringify(c)),
      category: typeof o.category === "string" ? o.category : undefined,
      check: typeof o.check === "string" ? o.check : undefined,
    };
  });
  const skills = arr(["skills", "targetSkills", "skillTags", "tags"]).map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).name ?? x)));
  return {
    title: s(["title", "name"]),
    summary: s(["summary", "tagline", "shortDescription", "description"]),
    environmentType: s(["environmentType"]),
    environmentVersion: s(["environmentVersion", "version"]),
    skills,
    claims,
    raw: j,
  };
}

/* ------------------------------ signed preview report ------------------------------ */

export type ReportVerification = SignedReport & {
  source: "tee" | "blob";
  hashMatchesChain: boolean;
  bundleMatches: boolean;
  versionMatches: boolean;
  recoveredSigner?: Address;
  signatureValid?: boolean;
  signerIsRunner?: boolean;
  onchainRunner?: Address;
  healthSigner?: string;
};

/**
 * The version's preview report: from the TEE's GET /reports/:id when it has one, else the public
 * blob addressed by the on-chain reportHash. The hash is always computed here over the exact
 * canonical bytes, the EIP-712 PreviewReport signature is recovered against the on-chain
 * (versionId, bundleHash, reportHash), and the signer's runner role is read from the contract.
 */
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
      let signed: SignedReport | null = null;
      let source: "tee" | "blob" = "tee";
      try {
        const st = await getReportState(v.id);
        if (st.state === "ready") signed = st.signed;
      } catch {
        /* fall back to the public blob */
      }
      if (!signed || !eqHash(signed.computedHash, v.reportHash)) {
        try {
          const blob = await getReportBlob(v.uri, v.reportHash);
          signed = { ...blob, signature: signed?.signature ?? null, signer: signed?.signer ?? null, attachTx: signed?.attachTx ?? null, disclosures: signed?.disclosures ?? null };
          source = "blob";
        } catch (e) {
          if (!signed) throw e;
        }
      }
      const s = signed!;
      let recoveredSigner: Address | undefined;
      let signatureValid: boolean | undefined;
      let signerIsRunner: boolean | undefined;
      if (s.signature && deployment) {
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
            message: { versionId: v.id, bundleHash: v.bundleHash, reportHash: s.computedHash },
            signature: s.signature,
          });
          signatureValid = eqHash(recoveredSigner, s.report.signer);
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
        ...s,
        source,
        hashMatchesChain: eqHash(s.computedHash, v.reportHash),
        bundleMatches: eqHash(s.report.bundleHash, v.bundleHash),
        versionMatches: String(s.report.versionId) === v.id.toString(),
        recoveredSigner,
        signatureValid,
        signerIsRunner,
        onchainRunner: attachEvent?.args.runner as Address | undefined,
        healthSigner,
      };
    },
  });
}

/** Preview progress on the TEE for a version that has no report attached yet. */
export function useReportState(versionId: bigint | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["report-state", versionId?.toString()],
    enabled: enabled && versionId !== undefined && !!TEE_URL,
    queryFn: () => getReportState(versionId!),
    refetchInterval: 15_000,
    retry: 0,
  });
}

export function useAttestation() {
  return useQuery({ queryKey: ["attestation"], queryFn: getAttestation, enabled: !!TEE_URL, staleTime: 5 * 60_000, retry: 0 });
}
export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: getHealth, enabled: !!TEE_URL, staleTime: 60_000, retry: 0 });
}

/** pass1Rounded is an integer percent (multiple of 5) or null when nothing was attempted. */
export function fmtPass(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Math.round(v)}%`;
}

export type { PreviewReport };

"use client";

import { useQuery } from "@tanstack/react-query";
import type { AttestationVerifyResult } from "@/app/api/attestation/verify/route";
import { eqHash } from "@/lib/crypto";
import { Chip, IconExternal, Verified } from "./ui";

/** Badge text per attestation kind. */
export function teeBadge(kind: string): string {
  return kind === "phala-dstack-tdx" ? "Phala Cloud · Intel TDX" : kind === "eigencompute-tdx" ? "EigenCompute · Intel TDX" : "none-local-dev: not a TEE";
}

export const phalaTrustUrl = (appId: string) => `https://trust.phala.com/app/${appId}`;

/**
 * Result of /api/attestation/verify: the Phala quote checked by Phala's public verifier on this app's
 * server, plus report_data, the RTMR3 replay, the compose/image pin and the signer's on-chain roles.
 */
export function PhalaVerification({ versionId, reportHash }: { versionId?: string; reportHash?: string | null }) {
  const q = useQuery({
    queryKey: ["phala-verify", versionId ?? null],
    queryFn: async (): Promise<AttestationVerifyResult> => {
      const r = await fetch(`/api/attestation/verify${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j as AttestationVerifyResult;
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });
  if (q.isLoading) return <Verified pending />;
  if (q.error || !q.data) return <span className="text-xs text-bad">verification unavailable ({(q.error as Error)?.message ?? "no data"})</span>;
  const d = q.data;
  const hashOk = d.report && reportHash ? eqHash(d.report.reportHash, reportHash) : null;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Verified ok={d.ok && hashOk !== false} okText="attestation checks passed" badText="an attestation check failed" />
        {d.trustUrl && (
          <a href={d.trustUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
            Phala Trust Center <IconExternal />
          </a>
        )}
      </div>
      <ul className="space-y-1">
        {d.checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start gap-2">
            {c.ok === null ? <Chip>n/a</Chip> : <Verified ok={c.ok} okText="ok" badText="failed" />}
            <span className="min-w-0 flex-1">
              {c.label}
              {c.detail && <span className="block text-faint [overflow-wrap:anywhere]">{c.detail}</span>}
            </span>
          </li>
        ))}
        {hashOk !== null && (
          <li className="flex flex-wrap items-start gap-2">
            <Verified ok={hashOk} okText="ok" badText="failed" />
            <span>The report hash the quote covers is the one this browser computed</span>
          </li>
        )}
      </ul>
      <p className="text-faint">Checked on this app&apos;s server at {new Date(d.checkedAt).toLocaleTimeString()} (Phala&apos;s verifier API has no CORS). Re-run it yourself with the quote from /attestation.</p>
    </div>
  );
}

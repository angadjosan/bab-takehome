"use client";

import type { ReactNode } from "react";
import { fmtPass, useAttestation, useReportState, useVerifiedReport, type ReportVerification } from "@/lib/docs";
import { eqHash } from "@/lib/crypto";
import { IS_MAINNET } from "@/lib/config";
import { isZeroHash, type Version } from "@/lib/market";
import { fmtTime, fmtUsdc } from "@/lib/format";
import type { Outcome } from "@/lib/tee";
import { PhalaVerification, phalaTrustUrl, teeBadge } from "./phala-attestation";
import { AddressLink, Chip, DetailSection, HashValue, IconExternal, Notice, Skeleton, Spinner, TxLink, Verified } from "./ui";

const iso = (s?: string | null) => (s ? fmtTime(Date.parse(s) / 1000) : "—");

/** One key/value row inside a `kv` list; the key is the report's field name. */
function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-mono text-xs">{k}</dt>
      <dd className="flex flex-wrap items-center gap-1.5">{children}</dd>
    </>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-xs [overflow-wrap:anywhere]">{children}</span>;

/* ------------------------------ verification summary ------------------------------ */

export type ReportCheck = { status: "ok" | "bad" | "pending" | "neutral"; text: string };

/** One line for the page's Details summary: did the signed report check out in this browser? */
export function useReportCheck(v: Version): ReportCheck {
  const q = useVerifiedReport(v);
  if (isZeroHash(v.reportHash)) return { status: "neutral", text: "No signed report attached" };
  if (q.isLoading) return { status: "pending", text: "Checking signed report…" };
  const d = q.data;
  if (q.error || !d) return { status: "bad", text: "Signed report failed to load" };
  const ok = d.hashMatchesChain && d.versionMatches && d.bundleMatches && d.canonical && d.schemaProblems.length === 0 && (d.signature ? !!d.signatureValid && d.signerIsRunner !== false : true);
  return ok ? { status: "ok", text: "Signed report verified" } : { status: "bad", text: "Signed report failed a check" };
}

/* ------------------------------ main flow: scores ------------------------------ */

/** Reference-model results and the validator explanation from the signed preview report. */
export function ReportScores({ v }: { v: Version }) {
  const q = useVerifiedReport(v);
  const noReport = isZeroHash(v.reportHash);
  const pending = useReportState(v.id, noReport);

  if (noReport) {
    const st = pending.data;
    if (st?.state === "running")
      return (
        <Notice tone="info" title="Preview running">
          {st.startedAt && (
            <span className="inline-flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5" /> Started {iso(st.startedAt)}
            </span>
          )}
        </Notice>
      );
    if (st?.state === "failed")
      return (
        <Notice tone="bad" title="Preview failed">
          {st.error}
        </Notice>
      );
    if (st?.state === "ready") return <Notice tone="warn" title="Report signed, not attached on-chain yet" />;
    return <Notice tone="warn" title="No preview report attached" />;
  }
  if (q.isLoading)
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  if (q.error || !q.data)
    return (
      <Notice tone="bad" title="Preview report failed to load">
        {(q.error as Error | null)?.message}
      </Notice>
    );

  const r = q.data.report;
  const screening = r.validator.screening;
  return (
    <div className="space-y-10">
      <section aria-labelledby="scores-title" className="space-y-3">
        <h2 id="scores-title" className="text-base font-semibold text-ink">
          Reference model scores
        </h2>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[560px]">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Status</th>
                <th scope="col">Purchased pass@1</th>
                <th scope="col">Audit pass@1</th>
                <th scope="col">Infra failures</th>
              </tr>
            </thead>
            <tbody>
              {r.models.map((m) => (
                <tr key={m.requested + (m.resolved ?? "")}>
                  <td>
                    <div className="text-ink">{m.requested}</div>
                    <div className="font-mono text-[11px] text-muted">
                      {m.resolved ?? "—"}
                      {m.provider ? ` · ${m.provider}` : ""}
                    </div>
                  </td>
                  <td>
                    <Chip tone={m.status === "run" ? "neutral" : "warn"}>{m.status}</Chip>
                  </td>
                  <td>
                    <Score o={m.purchased} bar />
                  </td>
                  <td>
                    <Score o={m.audit} />
                  </td>
                  <td className="font-mono">{m.infraFailures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.uncertainty && <p className="text-xs text-muted">Uncertainty: {r.uncertainty}</p>}
      </section>

      <section aria-labelledby="note-title" className="space-y-3">
        <h2 id="note-title" className="text-base font-semibold text-ink">
          Validator explanation
        </h2>
        {r.validator.explanation ? (
          <blockquote className="border-l-2 border-line-strong pl-4 text-[15px] leading-relaxed text-ink">{r.validator.explanation}</blockquote>
        ) : (
          <p className="text-[13px] text-muted">{screening.passed ? "Empty." : `Withheld by screening${screening.reasons.length ? `: ${screening.reasons.join("; ")}` : ""}.`}</p>
        )}
        <p className="font-mono text-xs text-muted">
          {r.validator.model} · prompt {r.validator.promptVersion}
        </p>
      </section>
    </div>
  );
}

function Score({ o, bar }: { o: Outcome; bar?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono">
      {bar && (
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-panel-2" aria-hidden>
          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, o.pass1Rounded ?? 0)}%` }} />
        </span>
      )}
      <span className="text-ink">{fmtPass(o.pass1Rounded)}</span>
      <span className="text-muted">
        {o.solved}/{o.attempted}
      </span>
    </span>
  );
}

/* ------------------------------ Details: technical ------------------------------ */

/** The signed report's remaining fields, the browser-side checks, and the attestation. */
export function ReportDetails({ v }: { v: Version }) {
  const q = useVerifiedReport(v);
  if (isZeroHash(v.reportHash)) return <p className="text-[13px] text-muted">No signed report attached.</p>;
  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.error || !q.data)
    return (
      <p className="text-[13px] text-bad [overflow-wrap:anywhere]">
        reportHash <span className="font-mono">{v.reportHash}</span> failed to load: {(q.error as Error | null)?.message}
      </p>
    );
  const d = q.data;
  const r = d.report;
  const onchain = (a: string, b: string) => <Verified ok={eqHash(a, b)} okText="= on-chain" badText="≠ on-chain" />;
  return (
    <div className="space-y-6">
      <DetailSection title="Report checks">
        <div className="flex flex-wrap gap-1.5">
          <Verified ok={d.hashMatchesChain} okText="sha256 = on-chain reportHash" badText="hash ≠ on-chain" title={`computed ${d.computedHash}`} />
          {d.signature ? <Verified ok={!!d.signatureValid && d.signerIsRunner !== false} okText="EIP-712 signer is a runner" badText="signer not a runner" /> : <Chip>signature checked by the contract at attach</Chip>}
          <Verified ok={d.schemaProblems.length === 0 && d.canonical} okText="strict report schema" badText="schema problems" title={d.schemaProblems.join("\n")} />
          <Verified ok={d.versionMatches} okText="versionId matches" badText="versionId ≠ this version" />
          <Verified ok={d.bundleMatches} okText="bundleHash matches" badText="bundleHash ≠ on-chain" />
        </div>
        {(d.schemaProblems.length > 0 || !d.canonical || !d.versionMatches || !d.bundleMatches) && (
          <div className="mt-3">
            <Notice tone="bad" title="Failed checks">
              <ul className="list-disc pl-4">
                {!d.versionMatches && (
                  <li>
                    report.versionId {r.versionId} ≠ {v.id.toString()}
                  </li>
                )}
                {!d.bundleMatches && <li>report.bundleHash ≠ on-chain bundleHash</li>}
                {!d.canonical && <li>report does not re-serialize to the signed canonical bytes</li>}
                {d.schemaProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
      </DetailSection>

      <DetailSection title="Report">
        <dl className="kv">
          <Row k="type">
            <Mono>{r.type}</Mono>
          </Row>
          <Row k="versionId">
            <Mono>{r.versionId}</Mono>
          </Row>
          <Row k="environmentVersion">
            <Mono>{r.environmentVersion}</Mono>
          </Row>
          <Row k="createdAt">{iso(r.createdAt)}</Row>
          <Row k="signer">
            <AddressLink address={r.signer} />
          </Row>
          <Row k="bundleHash">
            <HashValue value={r.bundleHash} />
            {onchain(r.bundleHash, v.bundleHash)}
          </Row>
          <Row k="ciphertextHash">
            <HashValue value={r.ciphertextHash} />
            {onchain(r.ciphertextHash, v.ciphertextHash)}
          </Row>
          <Row k="taskRoot">
            <HashValue value={r.taskRoot} />
            {onchain(r.taskRoot, v.taskRoot)}
          </Row>
          <Row k="auditRoot">
            <HashValue value={r.auditRoot} />
            {onchain(r.auditRoot, v.auditRoot)}
          </Row>
          {r.cachedFrom && (
            <Row k="cachedFrom">
              <Mono>
                version {r.cachedFrom.originalVersionId} · chain {r.cachedFrom.originalChainId} · run {iso(r.cachedFrom.originalRunAt)}
              </Mono>
            </Row>
          )}
          {r.inferenceCostUsd !== undefined && (
            <Row k="inferenceCostUsd">
              <Mono>{r.inferenceCostUsd} USD</Mono>
            </Row>
          )}
          {r.feePaidUsdc !== undefined && (
            <Row k="feePaidUsdc">
              <Mono>{/^[0-9]+$/.test(r.feePaidUsdc) ? fmtUsdc(BigInt(r.feePaidUsdc)) : r.feePaidUsdc}</Mono>
            </Row>
          )}
          {d.attachTx && (
            <Row k="attachTx">
              <TxLink hash={d.attachTx} />
            </Row>
          )}
        </dl>
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection title="protocol">
          <dl className="kv">
            <Row k="id">
              <Mono>{r.protocol.id}</Mono>
            </Row>
            <Row k="harnessDigest">
              <HashValue value={r.protocol.harnessDigest} />
            </Row>
            <Row k="promptDigest">
              <HashValue value={r.protocol.promptDigest} />
            </Row>
            {r.protocol.toolsDigest && (
              <Row k="toolsDigest">
                <HashValue value={r.protocol.toolsDigest} />
              </Row>
            )}
            {r.protocol.tokenBoundEnforced !== undefined && (
              <Row k="tokenBoundEnforced">
                <Mono>{String(r.protocol.tokenBoundEnforced)}</Mono>
              </Row>
            )}
            <Row k="decoding">
              <Mono>
                temperature {r.protocol.decoding.temperature} · seed {r.protocol.decoding.seed} · maxTokens {r.protocol.decoding.maxTokens}
              </Mono>
            </Row>
            <Row k="actionBudget">
              <Mono>{r.protocol.actionBudget}</Mono>
            </Row>
            <Row k="timeBudgetSec">
              <Mono>{r.protocol.timeBudgetSec}</Mono>
            </Row>
            <Row k="successRule">{r.protocol.successRule}</Row>
          </dl>
        </DetailSection>
        <div className="space-y-6">
          <DetailSection title="runtime">
            <dl className="kv">
              <Row k="imageDigest">
                <HashValue value={r.runtime.imageDigest} />
                {onchain(r.runtime.imageDigest, v.imageDigest)}
              </Row>
              <Row k="sandbox">
                <Mono>{r.runtime.sandbox}</Mono>
              </Row>
              <Row k="network">
                <Mono>{r.runtime.network}</Mono>
              </Row>
            </dl>
          </DetailSection>
          <DetailSection title="validator">
            <dl className="kv">
              <Row k="model">
                <Mono>{r.validator.model}</Mono>
              </Row>
              <Row k="promptVersion">
                <Mono>{r.validator.promptVersion}</Mono>
              </Row>
              <Row k="promptHash">
                <HashValue value={r.validator.promptHash} />
              </Row>
              <Row k="screening.passed">
                <Chip tone={r.validator.screening.passed ? "ok" : "warn"}>{String(r.validator.screening.passed)}</Chip>
              </Row>
              {r.validator.screening.reasons.length > 0 && <Row k="screening.reasons">{r.validator.screening.reasons.join("; ")}</Row>}
            </dl>
          </DetailSection>
        </div>
      </div>

      <DetailSection title={`jobs (${r.jobs.length})`}>
        {r.jobs.length ? (
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="data-table min-w-[520px] text-xs">
              <thead>
                <tr>
                  <th scope="col">jobId</th>
                  <th scope="col">startedAt</th>
                  <th scope="col">finishedAt</th>
                  <th scope="col">status</th>
                </tr>
              </thead>
              <tbody>
                {r.jobs.map((j) => (
                  <tr key={j.jobId}>
                    <td className="max-w-[14rem] truncate font-mono" title={j.jobId}>
                      {j.jobId}
                    </td>
                    <td>{iso(j.startedAt)}</td>
                    <td>{iso(j.finishedAt)}</td>
                    <td>
                      <Chip tone={j.status === "succeeded" ? "ok" : j.status === "failed" || j.status === "infra_failure" ? "bad" : "neutral"}>{j.status}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted">None.</p>
        )}
      </DetailSection>

      <AttestationBlock rv={d} />
    </div>
  );
}

function AttestationBlock({ rv }: { rv: ReportVerification }) {
  const live = useAttestation();
  const att = rv.report.attestation;
  const real = att.kind !== "none-local-dev";
  const phala = att.kind === "phala-dstack-tdx";
  // att.verifyUrl when the report has one; otherwise the Phala Trust Center or EigenCloud page for att.appId
  const verifyUrl = att.verifyUrl ?? (phala && att.appId ? phalaTrustUrl(att.appId) : real && att.appId ? `https://${IS_MAINNET ? "verify" : "verify-sepolia"}.eigencloud.xyz/app/${att.appId}` : null);
  const roles = live.data?.signerRoles;
  return (
    <DetailSection title="attestation">
      <dl className="kv">
        <Row k="kind">
          <Chip tone={real ? "ok" : "warn"}>{teeBadge(att.kind)}</Chip>
        </Row>
        <Row k="appId">
          <Mono>{att.appId ?? "null"}</Mono>
        </Row>
        <Row k="signer">
          <AddressLink address={att.signer} />
          {!eqHash(att.signer, rv.report.signer) && <Chip tone="bad">≠ report signer</Chip>}
        </Row>
        <Row k="quoteDigest">
          <HashValue value={att.quoteDigest} />
        </Row>
        <Row k="verifyUrl">
          {verifyUrl ? (
            <a href={verifyUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 text-xs [overflow-wrap:anywhere]">
              {verifyUrl} <IconExternal />
            </a>
          ) : (
            <Mono>null</Mono>
          )}
        </Row>
        {phala && (
          <Row k="Quote check">
            <PhalaVerification versionId={rv.report.versionId} reportHash={rv.computedHash} />
          </Row>
        )}
        {rv.recoveredSigner && (
          <Row k="Recovered signer">
            <AddressLink address={rv.recoveredSigner} />
            {rv.signerIsRunner !== undefined && <Verified ok={rv.signerIsRunner} okText="isRunner" badText="not a runner" />}
          </Row>
        )}
        {rv.onchainRunner && (
          <Row k="ReportAttached.runner">
            <AddressLink address={rv.onchainRunner} />
          </Row>
        )}
        <Row k="TEE /health signer">
          <AddressLink address={rv.healthSigner} />
          {rv.healthSigner && <Verified ok={eqHash(rv.healthSigner, rv.report.signer)} okText="= report signer" badText="≠ report signer" />}
          {roles && !("error" in roles) && (
            <span className="text-xs text-muted">
              {Object.entries(roles)
                .map(([k, on]) => `${k}: ${String(on)}`)
                .join(" · ")}
            </span>
          )}
        </Row>
        <Row k="TEE /attestation">
          {live.isLoading ? (
            <span className="text-xs text-muted">Loading…</span>
          ) : live.error ? (
            <span className="text-xs text-bad">{(live.error as Error).message}</span>
          ) : live.data ? (
            <details className="w-full text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">JSON</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-panel-2 p-2 font-mono text-[11px]">{JSON.stringify(live.data, null, 2)}</pre>
            </details>
          ) : (
            "—"
          )}
        </Row>
      </dl>
    </DetailSection>
  );
}

"use client";

import { fmtPass, useAttestation, useReportState, useVerifiedReport, type ReportVerification } from "@/lib/docs";
import { eqHash } from "@/lib/crypto";
import { IS_MAINNET } from "@/lib/config";
import { isZeroHash, type Version } from "@/lib/market";
import { fmtTime } from "@/lib/format";
import type { ModelResult } from "@/lib/tee";
import { PhalaVerification, phalaTrustUrl, teeBadge } from "./phala-attestation";
import { AddressLink, Chip, DetailSection, HashValue, IconExternal, Notice, Skeleton, Spinner, TxLink, Verified } from "./ui";

const iso = (s?: string | null) => (s ? fmtTime(Date.parse(s) / 1000) : "—");

/* ------------------------------ verification summary ------------------------------ */

export type ReportCheck = { status: "ok" | "bad" | "pending" | "neutral"; text: string };

/** One line for the page's Details summary: did the signed report check out in this browser? */
export function useReportCheck(v: Version): ReportCheck {
  const q = useVerifiedReport(v);
  if (isZeroHash(v.reportHash)) return { status: "neutral", text: "No signed report yet" };
  if (q.isLoading) return { status: "pending", text: "Checking the signed report…" };
  const d = q.data;
  if (q.error || !d) return { status: "bad", text: "The signed report could not be loaded" };
  const ok = d.hashMatchesChain && d.versionMatches && d.bundleMatches && d.canonical && d.schemaProblems.length === 0 && (d.signature ? !!d.signatureValid && d.signerIsRunner !== false : true);
  return ok ? { status: "ok", text: "Report signed by the TEE and matches the listing" } : { status: "bad", text: "The signed report failed a check" };
}

/* ------------------------------ main flow: scores ------------------------------ */

/** What a buyer reads first: how reference models scored, and the reviewer's note. */
export function ReportScores({ v }: { v: Version }) {
  const q = useVerifiedReport(v);
  const noReport = isZeroHash(v.reportHash);
  const pending = useReportState(v.id, noReport);

  if (noReport) {
    const st = pending.data;
    return st?.state === "running" ? (
      <Notice tone="info" title="The preview is running">
        <span className="inline-flex items-center gap-2">
          <Spinner className="h-3.5 w-3.5" /> Reference models are working through the tasks{st.startedAt ? ` (started ${iso(st.startedAt)})` : ""}. You can buy once the signed report is posted.
        </span>
      </Notice>
    ) : st?.state === "failed" ? (
      <Notice tone="bad" title="The preview run failed">
        {st.error}. The seller can request a new run. Purchases stay closed until a signed report is posted.
      </Notice>
    ) : st?.state === "ready" ? (
      <Notice tone="warn" title="Report signed, not posted yet">
        The preview finished and its report is signed. Anyone can post it; purchases open once it is on the market contract.
      </Notice>
    ) : (
      <Notice tone="warn" title="No preview yet">
        Nobody has run this environment through the reference models yet, so there are no scores to show. Purchases open once a signed report is posted.
      </Notice>
    );
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
      <Notice tone="bad" title="The preview report could not be loaded">
        The listing points to a signed report, but neither the TEE service nor the public file store returned it. Don’t buy on scores you can’t check; try again later.
      </Notice>
    );

  const r = q.data.report;
  const run = r.models.filter((m) => m.status === "run");
  const notRun = r.models.filter((m) => m.status !== "run");
  return (
    <div className="space-y-10">
      <section aria-labelledby="scores-title" className="space-y-4">
        <div>
          <h2 id="scores-title" className="text-base font-semibold text-ink">
            How reference models scored
          </h2>
          <p className="mt-1 text-[13px] text-muted">Share of tasks each model solved on its first try, rounded to 5 points. Scores show how today’s models do on these tasks. They don’t predict training gains.</p>
        </div>
        <ul className="space-y-4">
          {run.map((m) => (
            <ScoreRow key={m.requested + (m.resolved ?? "")} m={m} />
          ))}
          {notRun.map((m) => (
            <li key={m.requested} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="text-ink">{m.requested}</span>
              <span className="text-muted">Not run: unavailable in the protected runner</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="note-title" className="space-y-3">
        <h2 id="note-title" className="text-base font-semibold text-ink">
          Reviewer’s note
        </h2>
        {r.validator.explanation ? (
          <blockquote className="border-l-2 border-line-strong pl-4 text-[15px] leading-relaxed text-ink">{r.validator.explanation}</blockquote>
        ) : (
          <p className="text-[13px] text-muted">The reviewer’s note was withheld by the output screen.</p>
        )}
        <p className="text-xs text-muted">Written by an AI model that saw the environment inside the TEE, capped at 120 words and screened so it can’t leak tasks. It can be wrong.</p>
      </section>
    </div>
  );
}

function ScoreRow({ m }: { m: ModelResult }) {
  const pct = Math.min(100, m.purchased.pass1Rounded ?? 0);
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[12rem_minmax(0,1fr)_7rem]">
      <span className="truncate text-[13px] text-ink" title={m.resolved ?? m.requested}>
        {m.requested}
      </span>
      <span className="h-2 overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`${fmtPass(m.purchased.pass1Rounded)} of tasks solved`}>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-right font-mono text-[13px] tabular-nums">
        <span className="text-ink">{fmtPass(m.purchased.pass1Rounded)}</span>
        <span className="text-muted"> of {m.purchased.attempted}</span>
      </span>
    </li>
  );
}

/* ------------------------------ Details: technical ------------------------------ */

/** Everything a skeptic wants: signature and hash checks, protocol, job history, attestation. */
export function ReportDetails({ v }: { v: Version }) {
  const q = useVerifiedReport(v);
  if (isZeroHash(v.reportHash)) return <p className="text-[13px] text-muted">No signed report is posted for this version.</p>;
  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.error || !q.data)
    return (
      <p className="text-[13px] text-bad [overflow-wrap:anywhere]">
        On-chain reportHash <span className="font-mono">{v.reportHash}</span> could not be fetched from the TEE service or the blob store ({(q.error as Error)?.message}).
      </p>
    );
  const d = q.data;
  const r = d.report;
  return (
    <div className="space-y-6">
      <DetailSection title="Report checks" hint={`Created ${iso(r.createdAt)} · protocol ${r.protocol.id} · ${r.environmentVersion}`}>
        <div className="flex flex-wrap gap-1.5">
          <Verified ok={d.hashMatchesChain} okText="sha256 = on-chain reportHash" badText="hash ≠ on-chain" title={`computed ${d.computedHash}`} />
          {d.signature ? (
            <Verified ok={!!d.signatureValid && d.signerIsRunner !== false} okText="EIP-712 signer is an authorized runner" badText="signer not authorized" />
          ) : (
            <Chip title="The contract verified the runner signature when the report was attached.">signature checked on-chain at attach</Chip>
          )}
          <Verified ok={d.schemaProblems.length === 0 && d.canonical} okText="strict report schema" badText="schema problems" title={d.schemaProblems.join("\n")} />
          <Verified ok={d.versionMatches} okText="versionId matches" badText="versionId ≠ this version" />
          <Verified ok={d.bundleMatches} okText="bundleHash matches" badText="bundleHash ≠ on-chain" />
        </div>
        {(d.schemaProblems.length > 0 || !d.canonical || !d.versionMatches || !d.bundleMatches) && (
          <div className="mt-3">
            <Notice tone="bad" title="This report does not match what it should commit to">
              <ul className="list-disc pl-4">
                {!d.versionMatches && (
                  <li>
                    report.versionId {r.versionId} ≠ this version {v.id.toString()}
                  </li>
                )}
                {!d.bundleMatches && <li>report.bundleHash ≠ the version’s on-chain bundleHash</li>}
                {!d.canonical && <li>the parsed report does not re-serialize to the signed canonical bytes</li>}
                {d.schemaProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          Source: {d.source === "tee" ? "the TEE service’s GET /reports" : "the public blob store, addressed by the on-chain reportHash"}.
          {d.attachTx && (
            <>
              {" "}
              Attached in <TxLink hash={d.attachTx} />.
            </>
          )}
        </p>
      </DetailSection>

      <DetailSection title="Scores in full" hint={`${r.uncertainty} Audit-holdout tasks are never delivered. Infrastructure failures count as attempted, not solved.`}>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[520px]">
            <thead>
              <tr>
                <th>Model</th>
                <th>Purchased</th>
                <th>Audit holdout</th>
                <th>Infra failures</th>
              </tr>
            </thead>
            <tbody>
              {r.models.map((m) => (
                <tr key={m.requested + (m.resolved ?? "")}>
                  <td>
                    <div className="text-ink">{m.requested}</div>
                    <div className="font-mono text-[11px] text-muted">
                      {m.status === "run" ? `${m.resolved ?? "—"}${m.provider ? ` · ${m.provider}` : ""}` : (m.provider ?? "not available in the protected runner")}
                    </div>
                  </td>
                  {m.status === "run" ? (
                    <>
                      <td className="font-mono">
                        {fmtPass(m.purchased.pass1Rounded)} <span className="text-muted">n={m.purchased.attempted}</span>
                      </td>
                      <td className="font-mono">
                        {fmtPass(m.audit.pass1Rounded)} <span className="text-muted">n={m.audit.attempted}</span>
                      </td>
                      <td className="font-mono">{m.infraFailures}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="text-muted">
                      Not run. No score is shown rather than silently substituting another model.
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DetailSection>

      <DetailSection title="Reviewer (validator)">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Chip tone={r.validator.screening.passed ? "ok" : "warn"}>output screening {r.validator.screening.passed ? "passed" : "withheld text"}</Chip>
          {r.validator.screening.reasons.length ? <span>reasons: {r.validator.screening.reasons.join("; ")}</span> : null}
          <span>
            model <span className="font-mono">{r.validator.model}</span> · prompt {r.validator.promptVersion}
          </span>
          <span className="inline-flex items-center gap-1">
            prompt hash <HashValue value={r.validator.promptHash} />
          </span>
        </div>
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection title="Protocol & runtime">
          <dl className="kv">
            <dt>Harness digest</dt>
            <dd>
              <HashValue value={r.protocol.harnessDigest} />
            </dd>
            <dt>Prompt digest</dt>
            <dd>
              <HashValue value={r.protocol.promptDigest} />
            </dd>
            <dt>Decoding</dt>
            <dd className="font-mono text-xs">
              temp {r.protocol.decoding.temperature} · seed {r.protocol.decoding.seed} · max {r.protocol.decoding.maxTokens} tok
            </dd>
            <dt>Budgets</dt>
            <dd className="tabular-nums">
              {r.protocol.actionBudget} actions · {r.protocol.timeBudgetSec} s
            </dd>
            <dt>Success rule</dt>
            <dd>{r.protocol.successRule}</dd>
            <dt>Sandbox</dt>
            <dd>
              {r.runtime.sandbox} · network <span className="font-mono">{r.runtime.network}</span>
            </dd>
            <dt>Image digest</dt>
            <dd className="flex flex-wrap items-center gap-1">
              <HashValue value={r.runtime.imageDigest} />
              <Verified ok={eqHash(r.runtime.imageDigest, v.imageDigest)} okText="= on-chain" badText="≠ on-chain" />
            </dd>
            <dt>Bundle hash</dt>
            <dd className="flex flex-wrap items-center gap-1">
              <HashValue value={r.bundleHash} />
              <Verified ok={d.bundleMatches} okText="= on-chain" badText="≠ on-chain" />
            </dd>
            <dt>Task / audit roots</dt>
            <dd>
              <Verified ok={eqHash(r.taskRoot, v.taskRoot) && eqHash(r.auditRoot, v.auditRoot)} okText="both = on-chain" badText="≠ on-chain" />
            </dd>
          </dl>
        </DetailSection>
        <DetailSection title="Job history" hint="Every scheduled job, including failed and superseded ones, so a seller can’t publish only favorable runs. Status says whether a job was graded, not whether a task was solved.">
          <ul className="max-h-72 divide-y divide-line overflow-auto rounded-md border border-line text-xs">
            {r.jobs.map((j) => (
              <li key={j.jobId} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 truncate font-mono" title={j.jobId}>
                  {j.jobId}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-muted">
                  {iso(j.startedAt)}
                  <Chip tone={j.status === "succeeded" ? "ok" : j.status === "failed" || j.status === "infra_failure" ? "bad" : "neutral"}>{j.status.replace("_", " ")}</Chip>
                </span>
              </li>
            ))}
            {!r.jobs.length && <li className="px-3 py-2 text-muted">No jobs listed.</li>}
          </ul>
        </DetailSection>
      </div>

      <AttestationBlock rv={d} />
    </div>
  );
}

function AttestationBlock({ rv }: { rv: ReportVerification }) {
  const live = useAttestation();
  const att = rv.report.attestation;
  const real = att.kind !== "none-local-dev";
  const phala = att.kind === "phala-dstack-tdx";
  // Phala Trust Center report, or EigenCompute's verify dashboard (sepolia environment on testnet)
  const verifyUrl = att.verifyUrl ?? (phala && att.appId ? phalaTrustUrl(att.appId) : real && att.appId ? `https://${IS_MAINNET ? "verify" : "verify-sepolia"}.eigencloud.xyz/app/${att.appId}` : null);
  const signer = rv.recoveredSigner ?? rv.report.signer;
  const roles = live.data?.signerRoles;
  return (
    <DetailSection title="Execution attestation">
      <div className="mb-3">
        <Chip tone={real ? "ok" : "warn"}>{teeBadge(att.kind)}</Chip>
        {!real && <p className="mt-2 text-xs text-warn">This report came from the service running in local development mode. The host machine could see everything; no hardware attestation backs it.</p>}
      </div>
      <dl className="kv">
        <dt>Report signer</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AddressLink address={signer} />
          {rv.signerIsRunner !== undefined && <Verified ok={rv.signerIsRunner} okText="isRunner = true" badText="not a runner" />}
          {!eqHash(att.signer, rv.report.signer) && <Chip tone="bad">attestation.signer ≠ signer</Chip>}
        </dd>
        {rv.onchainRunner && (
          <>
            <dt>Runner at attach</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <AddressLink address={rv.onchainRunner} />
              <span className="text-xs text-muted">from the ReportAttached event (signature verified by the contract)</span>
            </dd>
          </>
        )}
        <dt>TEE service signer</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AddressLink address={rv.healthSigner} />
          {rv.healthSigner && signer && <Verified ok={eqHash(rv.healthSigner, signer)} okText="same key as report" badText="different key" />}
          {roles && !("error" in roles) && (
            <span className="text-xs text-muted">
              on-chain roles:{" "}
              {Object.entries(roles)
                .map(([k, on]) => `${k} ${on ? "✓" : "✗"}`)
                .join(" · ")}
            </span>
          )}
        </dd>
        <dt>App ID</dt>
        <dd className="font-mono text-xs">{att.appId ?? "—"}</dd>
        <dt>Quote digest</dt>
        <dd>
          <HashValue value={att.quoteDigest} />
        </dd>
        <dt>Verify</dt>
        <dd>
          {verifyUrl ? (
            <a href={verifyUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
              {phala ? "Phala Trust Center report" : "EigenCloud verification dashboard"} <IconExternal />
            </a>
          ) : (
            "—"
          )}
        </dd>
        {phala && (
          <>
            <dt>Quote check</dt>
            <dd>
              <PhalaVerification versionId={rv.report.versionId} reportHash={rv.computedHash} />
            </dd>
          </>
        )}
        <dt>Live /attestation</dt>
        <dd className="text-xs">{live.isLoading ? "Loading…" : live.error ? <span className="text-bad">unavailable ({(live.error as Error).message})</span> : live.data ? <LiveAtt data={live.data} /> : "—"}</dd>
      </dl>
      <div className="mt-4 grid gap-4 text-xs leading-relaxed text-muted sm:grid-cols-2">
        <div>
          <div className="font-medium text-ink">What this proves</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>The report bytes you see hash to the reportHash committed on-chain for this exact version.</li>
            <li>The signing key belongs to an address the market owner authorized as a runner.</li>
            {real && <li>The attestation binds that key to a specific app image running in an Intel TDX confidential VM on {phala ? "Phala Cloud (dstack)" : "EigenCompute"}.</li>}
          </ul>
        </div>
        <div>
          <div className="font-medium text-ink">What it doesn’t prove</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>That the scores or the reviewer’s note are correct, or that the operator is neutral.</li>
            <li>That training on this environment will help your model.</li>
            <li>Anything about reward hacking, which previews and disputes don’t cover.</li>
            {!real && <li>Hardware isolation: no TEE attestation backs this report.</li>}
          </ul>
        </div>
      </div>
    </DetailSection>
  );
}

function LiveAtt({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data)
    .filter(([, v]) => typeof v !== "object" || v === null)
    .slice(0, 8);
  return (
    <details>
      <summary className="cursor-pointer text-muted hover:text-ink">
        {String(data.kind ?? "response")} {data.appId ? `· ${String(data.appId).slice(0, 12)}…` : ""} (expand)
      </summary>
      <div className="mt-1 space-y-0.5 font-mono text-[11px]">
        {entries.map(([k, v]) => (
          <div key={k} className="[overflow-wrap:anywhere]">
            {k}: {String(v)}
          </div>
        ))}
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-panel-2 p-2">{JSON.stringify(data, null, 2)}</pre>
      </div>
    </details>
  );
}

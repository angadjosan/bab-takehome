"use client";

import { fmtPass, useAttestation, useReportState, useVerifiedReport, type ReportVerification } from "@/lib/docs";
import { eqHash } from "@/lib/crypto";
import { IS_MAINNET } from "@/lib/config";
import { isZeroHash, type Version } from "@/lib/market";
import { fmtTime } from "@/lib/format";
import type { ModelResult, Outcome } from "@/lib/tee";
import { AddressLink, Card, HashValue, IconExternal, Notice, Skeleton, Spinner, TxLink, Verified } from "./ui";

const iso = (s?: string | null) => (s ? fmtTime(Date.parse(s) / 1000) : "—");

export function ReportPanel({ v }: { v: Version }) {
  const q = useVerifiedReport(v);
  const pending = useReportState(v.id, isZeroHash(v.reportHash));
  if (isZeroHash(v.reportHash)) {
    const st = pending.data;
    return (
      <Card title="Signed preview report">
        {st?.state === "running" ? (
          <Notice tone="info" title="Preview running in the TEE">
            <span className="inline-flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5" /> The reference panel and validator are running{st.startedAt ? ` (started ${iso(st.startedAt)})` : ""}. The report is attached on-chain when it finishes; purchases open then.
            </span>
          </Notice>
        ) : st?.state === "failed" ? (
          <Notice tone="bad" title="The preview run failed">
            {st.error}. The seller can request a new run; the contract refuses purchases until a signed report is attached.
          </Notice>
        ) : st?.state === "ready" ? (
          <Notice tone="warn" title="Report signed but not attached yet">
            The TEE holds a signed report (sha256 <span className="font-mono">{st.signed.computedHash.slice(0, 18)}…</span>) that is not on-chain yet. Anyone can submit it with the runner signature.
          </Notice>
        ) : (
          <Notice tone="warn" title="No preview report attached yet">
            The TEE runner has not attached a signed report to this version. The contract refuses purchases until one is attached.
          </Notice>
        )}
      </Card>
    );
  }
  if (q.isLoading)
    return (
      <Card title="Signed preview report">
        <Skeleton className="h-48" />
      </Card>
    );
  if (q.error || !q.data)
    return (
      <Card title="Signed preview report">
        <Notice tone="bad" title="Could not load the report">
          On-chain reportHash is <span className="font-mono">{v.reportHash}</span> but the report document could not be fetched from the TEE service or the blob store ({(q.error as Error)?.message}). Do not buy on the strength of a
          report you cannot verify.
        </Notice>
      </Card>
    );
  const d = q.data;
  const r = d.report;
  const run = r.models.filter((m) => m.status === "run");
  const notRun = r.models.filter((m) => m.status !== "run");

  return (
    <Card
      title="Signed preview report"
      subtitle={`Created ${iso(r.createdAt)} · protocol ${r.protocol.id} · ${r.environmentVersion}`}
      action={
        <div className="flex flex-wrap gap-1.5">
          <Verified ok={d.hashMatchesChain} okText="sha256 = on-chain reportHash" badText="hash ≠ on-chain" title={`computed ${d.computedHash}`} />
          {d.signature ? (
            <Verified ok={!!d.signatureValid && d.signerIsRunner !== false} okText="EIP-712 signer is an authorized runner" badText="signer not authorized" />
          ) : (
            <span className="badge badge-neutral" title="The contract verified the runner signature when the report was attached.">signature checked on-chain at attach</span>
          )}
          <Verified ok={d.schemaProblems.length === 0 && d.canonical} okText="strict report schema" badText="schema problems" title={d.schemaProblems.join("\n")} />
        </div>
      }
    >
      <div className="space-y-6">
        {(d.schemaProblems.length > 0 || !d.canonical || !d.versionMatches || !d.bundleMatches) && (
          <Notice tone="bad" title="This report does not match what it should commit to">
            <ul className="list-disc pl-4">
              {!d.versionMatches && <li>report.versionId {r.versionId} ≠ this version {v.id.toString()}</li>}
              {!d.bundleMatches && <li>report.bundleHash ≠ the version’s on-chain bundleHash</li>}
              {!d.canonical && <li>the parsed report does not re-serialize to the signed canonical bytes</li>}
              {d.schemaProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        )}
        <div>
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">Reference-model pass@1</h3>
            <span className="text-xs text-muted">rounded to 5 percentage points</span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Purchased tasks</th>
                  <th className="py-2 pr-3 font-medium">Audit holdout</th>
                  <th className="py-2 font-medium">Infra failures</th>
                </tr>
              </thead>
              <tbody>
                {[...run, ...notRun].map((m) => (
                  <ModelRow key={m.requested + (m.resolved ?? "")} m={m} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            {r.uncertainty} Purchased-task and audit-holdout scores are reported separately; audit tasks are never delivered to buyers. pass@1 = tasks solved in their first episode ÷ tasks attempted
            (infrastructure failures count as attempted, not solved). It measures today’s reference models on this environment and is <strong>not evidence that training on it will improve your model</strong>.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold">Validator explanation</h3>
          <div className="mt-2 rounded-lg border border-line bg-panel-2 p-4 text-sm leading-relaxed">
            <p>{r.validator.explanation || <span className="text-muted">No explanation.</span>}</p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className={r.validator.screening.passed ? "badge badge-ok" : "badge badge-warn"}>output screening {r.validator.screening.passed ? "passed" : "withheld text"}</span>
            {r.validator.screening.reasons.length ? <span>reasons: {r.validator.screening.reasons.join("; ")}</span> : null}
            <span>
              model <span className="font-mono">{r.validator.model}</span> · prompt {r.validator.promptVersion}
            </span>
            <span>
              prompt hash <HashValue value={r.validator.promptHash} />
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Written by an AI validator with a fixed public prompt, capped at 120 words and screened for copied code, paths, task identifiers, and injected instructions. It can still be wrong; treat it as an
            opinion, not a finding.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold">Protocol & runtime</h3>
            <dl className="kv mt-2">
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
              <dd>
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
              <dd className="flex flex-wrap items-center gap-1">
                <Verified ok={eqHash(r.taskRoot, v.taskRoot) && eqHash(r.auditRoot, v.auditRoot)} okText="both = on-chain" badText="≠ on-chain" />
              </dd>
            </dl>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Job history</h3>
            <p className="mt-1 text-xs text-muted">
              Every scheduled job, including failed and superseded ones, so a seller cannot publish only favorable runs. A job status says whether it was graded, never whether the task was solved.
            </p>
            <ul className="mt-2 max-h-72 divide-y divide-line overflow-auto rounded-lg border border-line text-xs">
              {r.jobs.map((j) => (
                <li key={j.jobId} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate font-mono">{j.jobId}</span>
                  <span className="flex shrink-0 items-center gap-2 text-muted">
                    {iso(j.startedAt)}
                    <span className={j.status === "succeeded" ? "badge badge-ok" : j.status === "failed" || j.status === "infra_failure" ? "badge badge-bad" : "badge badge-neutral"}>{j.status.replace("_", " ")}</span>
                  </span>
                </li>
              ))}
              {!r.jobs.length && <li className="px-3 py-2 text-muted">No jobs listed.</li>}
            </ul>
          </div>
        </div>

        <AttestationBlock rv={d} />
        <p className="text-xs text-muted">
          Source: {d.source === "tee" ? "the TEE service’s GET /reports" : "the public blob store, addressed by the on-chain reportHash"}.
          {d.attachTx && (
            <>
              {" "}
              Attached in <TxLink hash={d.attachTx} />.
            </>
          )}
        </p>
      </div>
    </Card>
  );
}

function ModelRow({ m }: { m: ModelResult }) {
  if (m.status !== "run")
    return (
      <tr className="border-b border-line last:border-0">
        <td className="py-2.5 pr-3">
          <div className="font-medium">{m.requested}</div>
          <div className="text-xs text-muted">{m.provider ?? "not available in the protected runner"}</div>
        </td>
        <td className="py-2.5 pr-3" colSpan={3}>
          <span className="badge badge-neutral">not run</span>
          <span className="ml-2 text-xs text-muted">No score is shown rather than silently substituting another model.</span>
        </td>
      </tr>
    );
  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-2.5 pr-3">
        <div className="font-medium">{m.requested}</div>
        <div className="font-mono text-[11px] text-muted">
          {m.resolved ?? "—"}
          {m.provider ? ` · ${m.provider}` : ""}
        </div>
      </td>
      <td className="py-2.5 pr-3">
        <Score s={m.purchased} />
      </td>
      <td className="py-2.5 pr-3">
        <Score s={m.audit} />
      </td>
      <td className="py-2.5 tabular-nums">{m.infraFailures}</td>
    </tr>
  );
}

function Score({ s }: { s: Outcome }) {
  return (
    <div className="min-w-[8rem]">
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold tabular-nums">{fmtPass(s.pass1Rounded)}</span>
        <span className="text-xs text-muted">n={s.attempted}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-panel-2">
        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.min(100, s.pass1Rounded ?? 0)}%` }} />
      </div>
    </div>
  );
}

function AttestationBlock({ rv }: { rv: ReportVerification }) {
  const live = useAttestation();
  const att = rv.report.attestation;
  const real = att.kind === "eigencompute-tdx";
  // EigenCompute's verify dashboard; the testnet deployment runs in the EigenCompute sepolia environment
  const verifyUrl = att.verifyUrl ?? (real && att.appId ? `https://${IS_MAINNET ? "verify" : "verify-sepolia"}.eigencloud.xyz/app/${att.appId}` : null);
  const signer = rv.recoveredSigner ?? rv.report.signer;
  const roles = live.data?.signerRoles;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Execution attestation</h3>
        <span className={real ? "badge badge-ok" : "badge badge-warn"}>{real ? "EigenCompute · Intel TDX" : "none-local-dev: not a TEE"}</span>
      </div>
      {!real && (
        <p className="mt-2 text-xs text-warn">This report was produced by the service running in local development mode. The host machine could see everything; no hardware attestation backs it.</p>
      )}
      <dl className="kv mt-3">
        <dt>Report signer</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AddressLink address={signer} />
          {rv.signerIsRunner !== undefined && <Verified ok={rv.signerIsRunner} okText="isRunner = true" badText="not a runner" />}
          {!eqHash(att.signer, rv.report.signer) && <span className="badge badge-bad">attestation.signer ≠ signer</span>}
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
              on-chain roles: {Object.entries(roles).map(([k, on]) => `${k} ${on ? "✓" : "✗"}`).join(" · ")}
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
              EigenCloud verification dashboard <IconExternal />
            </a>
          ) : (
            "—"
          )}
        </dd>
        <dt>Live /attestation</dt>
        <dd className="text-xs">
          {live.isLoading ? "loading…" : live.error ? <span className="text-bad">unavailable ({(live.error as Error).message})</span> : live.data ? <LiveAtt data={live.data} /> : "—"}
        </dd>
      </dl>
      <div className="mt-4 grid gap-3 text-xs leading-relaxed text-muted sm:grid-cols-2">
        <div>
          <div className="font-semibold text-ink">What this proves</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>The report bytes you see hash to the reportHash committed on-chain for this exact version.</li>
            <li>The signing key belongs to an address the market owner authorized as a runner.</li>
            {real && <li>The attestation binds that key to a specific app image running in an Intel TDX confidential VM on EigenCompute.</li>}
          </ul>
        </div>
        <div>
          <div className="font-semibold text-ink">What it does not prove</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>That the scores or explanation are correct, or that the operator is neutral.</li>
            <li>That training on this environment will help your model.</li>
            <li>Anything about reward hacking, which is out of scope for previews and disputes.</li>
            {!real && <li>Hardware isolation: this report is not backed by a TEE attestation.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function LiveAtt({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => typeof v !== "object" || v === null).slice(0, 8);
  return (
    <details>
      <summary className="cursor-pointer text-accent">
        {String(data.kind ?? "response")} {data.appId ? `· ${String(data.appId).slice(0, 12)}…` : ""} (expand)
      </summary>
      <div className="mt-1 space-y-0.5 font-mono text-[11px]">
        {entries.map(([k, v]) => (
          <div key={k} className="break-all">
            {k}: {String(v)}
          </div>
        ))}
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-panel-2 p-2">{JSON.stringify(data, null, 2)}</pre>
      </div>
    </details>
  );
}

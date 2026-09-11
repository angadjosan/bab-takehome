"use client";

import { fmtPass, useAttestation, useVerifiedReport } from "@/lib/docs";
import { eqHash } from "@/lib/crypto";
import { isZeroHash, type Version } from "@/lib/market";
import { fmtTime } from "@/lib/format";
import type { ModelResult } from "@/lib/tee";
import { AddressLink, Card, HashValue, IconExternal, Notice, Skeleton, Verified } from "./ui";

export function ReportPanel({ v }: { v: Version }) {
  const q = useVerifiedReport(v);
  if (isZeroHash(v.reportHash))
    return (
      <Card title="Signed preview report">
        <Notice tone="warn" title="No preview report attached yet">
          The TEE runner has not attached a signed report to this version. The contract refuses purchases until one is attached.
        </Notice>
      </Card>
    );
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
          On-chain reportHash is <span className="font-mono">{v.reportHash}</span> but the report document could not be fetched from the TEE service
          ({(q.error as Error)?.message}). Do not buy on the strength of a report you cannot verify.
        </Notice>
      </Card>
    );
  const r = q.data.report;
  const models = r.models ?? [];
  const run = models.filter((m) => m.status === "run");
  const notRun = models.filter((m) => m.status !== "run");
  const expl = r.validator?.explanation;
  const screened = r.validator?.screening;

  return (
    <Card
      title="Signed preview report"
      subtitle={`Created ${r.createdAt ? fmtTime(typeof r.createdAt === "number" ? r.createdAt : Date.parse(String(r.createdAt)) / 1000) : "—"} · protocol ${r.protocol?.id ?? "—"}`}
      action={
        <div className="flex flex-wrap gap-1.5">
          <Verified ok={q.data.hashMatchesChain} okText="sha256 = on-chain reportHash" badText="hash ≠ on-chain" title={`computed ${q.data.computedHash}`} />
          {q.data.signature ? (
            <Verified ok={q.data.signatureValid && q.data.signerIsRunner !== false} okText="EIP-712 signer is an authorized runner" badText="signer not authorized" />
          ) : (
            <span className="badge badge-neutral">signature checked on-chain at attach</span>
          )}
        </div>
      }
    >
      <div className="space-y-6">
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
                {run.map((m) => (
                  <ModelRow key={m.requested + (m.resolved ?? "")} m={m} />
                ))}
                {notRun.map((m) => (
                  <ModelRow key={m.requested} m={m} />
                ))}
                {!models.length && (
                  <tr>
                    <td colSpan={4} className="py-3 text-muted">
                      Report lists no models.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            {r.uncertainty ?? "Small task populations make these numbers coarse."} Purchased-task and audit-holdout scores are reported separately; audit tasks are never
            delivered to buyers. pass@1 = tasks solved in their first episode ÷ tasks attempted; it measures today’s reference models on this environment and is{" "}
            <strong>not evidence that training on it will improve your model</strong>.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold">Validator explanation</h3>
          <div className="mt-2 rounded-lg border border-line bg-panel-2 p-4 text-sm leading-relaxed">
            {typeof expl === "string" ? (
              <p>{expl}</p>
            ) : expl && typeof expl === "object" ? (
              <dl className="kv">
                {Object.entries(expl).map(([k, val]) => (
                  <Frag key={k} k={k} v={val} />
                ))}
              </dl>
            ) : (
              <p className="text-muted">No explanation.</p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            {screened && (
              <span className={screened.passed ? "badge badge-ok" : "badge badge-warn"}>
                output screening {screened.passed ? "passed" : "withheld text"}
              </span>
            )}
            {screened?.reasons?.length ? <span>reasons: {screened.reasons.join("; ")}</span> : null}
            <span>
              model <span className="font-mono">{r.validator?.model ?? "—"}</span> · prompt {r.validator?.promptVersion ?? "—"}
            </span>
            {r.validator?.promptHash && (
              <span>
                prompt hash <HashValue value={r.validator.promptHash} />
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            Written by an AI validator with a fixed public prompt, capped at 120 words and screened for copied code, paths, task identifiers, and injected
            instructions. It can still be wrong; treat it as an opinion, not a finding.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold">Protocol & runtime</h3>
            <dl className="kv mt-2">
              <dt>Harness digest</dt>
              <dd><HashValue value={r.protocol?.harnessDigest} /></dd>
              <dt>Prompt digest</dt>
              <dd><HashValue value={r.protocol?.promptDigest} /></dd>
              <dt>Decoding</dt>
              <dd className="font-mono text-xs">
                {r.protocol?.decoding ? `temp ${r.protocol.decoding.temperature ?? "—"} · seed ${r.protocol.decoding.seed ?? "—"} · max ${r.protocol.decoding.maxTokens ?? "—"} tok` : "—"}
              </dd>
              <dt>Budgets</dt>
              <dd>
                {r.protocol?.actionBudget ?? "—"} actions · {r.protocol?.timeBudgetSec ?? "—"} s
              </dd>
              <dt>Success rule</dt>
              <dd>{r.protocol?.successRule ?? "—"}</dd>
              <dt>Sandbox</dt>
              <dd>
                {r.runtime?.sandbox ?? "—"} · network <span className="font-mono">{r.runtime?.network ?? "—"}</span>
              </dd>
              <dt>Image digest</dt>
              <dd><HashValue value={r.runtime?.imageDigest} /></dd>
              <dt>Bundle hash</dt>
              <dd className="flex flex-wrap items-center gap-1">
                <HashValue value={r.bundleHash} />
                <Verified ok={q.data.bundleMatches} okText="= on-chain" badText="≠ on-chain" />
              </dd>
            </dl>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Job history</h3>
            <p className="mt-1 text-xs text-muted">Every scheduled job, including failed and superseded ones, so a seller cannot publish only favorable runs.</p>
            <ul className="mt-2 divide-y divide-line rounded-lg border border-line text-xs">
              {(r.jobs ?? []).map((j) => (
                <li key={j.jobId} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate font-mono">{j.jobId}</span>
                  <span className="flex items-center gap-2 text-muted">
                    {j.startedAt ? fmtTime(typeof j.startedAt === "number" ? j.startedAt : Date.parse(String(j.startedAt)) / 1000) : ""}
                    <span className={j.status === "completed" || j.status === "succeeded" || j.status === "ok" ? "badge badge-ok" : j.status === "failed" ? "badge badge-bad" : "badge badge-neutral"}>
                      {j.status}
                    </span>
                  </span>
                </li>
              ))}
              {!r.jobs?.length && <li className="px-3 py-2 text-muted">No jobs listed.</li>}
            </ul>
          </div>
        </div>

        <AttestationBlock report={q.data} />
      </div>
    </Card>
  );
}

function Frag({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt className="capitalize">{k.replace(/([A-Z])/g, " $1")}</dt>
      <dd>{Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v)}</dd>
    </>
  );
}

function ModelRow({ m }: { m: ModelResult }) {
  if (m.status !== "run")
    return (
      <tr className="border-b border-line last:border-0">
        <td className="py-2.5 pr-3">
          <div className="font-medium">{m.requested}</div>
          <div className="text-xs text-muted">{m.note ?? m.provider ?? "not available in the protected runner"}</div>
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
      <td className="py-2.5 tabular-nums">{m.infraFailures ?? 0}</td>
    </tr>
  );
}

function Score({ s }: { s?: { attempted: number; solved?: number; pass1Rounded: number | null } }) {
  if (!s) return <span className="text-faint">—</span>;
  const p = s.pass1Rounded;
  const pctv = p === null || p === undefined ? null : p <= 1 ? p * 100 : p;
  return (
    <div className="min-w-[8rem]">
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold tabular-nums">{fmtPass(p)}</span>
        <span className="text-xs text-muted">n={s.attempted}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-panel-2">
        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.min(100, pctv ?? 0)}%` }} />
      </div>
    </div>
  );
}

function AttestationBlock({ report: rv }: { report: NonNullable<ReturnType<typeof useVerifiedReport>["data"]> }) {
  const live = useAttestation();
  const att = rv.report.attestation ?? {};
  const kind = att.kind ?? "unknown";
  const real = kind === "eigencompute-tdx";
  const signer = rv.recoveredSigner ?? rv.report.signer ?? att.signer;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Execution attestation</h3>
        <span className={real ? "badge badge-ok" : "badge badge-warn"}>{real ? "EigenCompute · Intel TDX" : kind}</span>
      </div>
      <dl className="kv mt-3">
        <dt>Report signer</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AddressLink address={signer} />
          {rv.signerIsRunner !== undefined && <Verified ok={rv.signerIsRunner} okText="isRunner = true" badText="not a runner" />}
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
        </dd>
        <dt>App ID</dt>
        <dd className="font-mono text-xs">{att.appId ?? "—"}</dd>
        <dt>Quote digest</dt>
        <dd><HashValue value={att.quoteDigest} /></dd>
        <dt>Verify</dt>
        <dd>
          {att.verifyUrl ? (
            <a href={att.verifyUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
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
  const entries = Object.entries(data).filter(([, v]) => typeof v !== "object" || v === null).slice(0, 6);
  return (
    <details>
      <summary className="cursor-pointer text-accent">
        {String(data.kind ?? data.type ?? "response")} {data.appId ? `· ${String(data.appId).slice(0, 12)}…` : ""} (expand)
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

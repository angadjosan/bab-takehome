/** Verification of a signed preview report against the on-chain version (used by seller + buyer). */
import type { Address, Hex } from 'viem';
import { canonicalJson, envMarketDomain, parseReport, recoverEnvMarketSigner, sha256Hex, type Report } from '@envmarket/shared';
import { marketRead, type Ctx, type VersionTerms } from './ctx.ts';

export interface SignedReportPayload {
  report: unknown; // canonical JSON text or object
  reportHash?: string;
  signature?: string;
}

export interface VerifiedReport {
  report: Report;
  reportText: string;
  reportHash: Hex;
  signer: Address | null;
  checks: string[];
}

export class ReportVerificationError extends Error {}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Canonical report text from either the exact text or an object. */
export function reportTextOf(report: unknown): string {
  if (typeof report === 'string') return report;
  return canonicalJson(report);
}

export async function verifyReport(ctx: Ctx, versionId: bigint, version: VersionTerms, p: SignedReportPayload, opts: { requireSignature?: boolean } = {}): Promise<VerifiedReport> {
  const checks: string[] = [];
  const fail = (m: string) => {
    throw new ReportVerificationError(`report for version ${versionId}: ${m}`);
  };
  const reportText = reportTextOf(p.report);
  const reportHash = sha256Hex(reportText);
  if (p.reportHash && !eq(p.reportHash, reportHash)) fail(`reportHash ${p.reportHash} != sha256(report) ${reportHash}`);
  checks.push(`reportHash = sha256(canonical report) = ${reportHash}`);
  let report: Report;
  try {
    report = parseReport(reportText);
  } catch (e) {
    return fail(`schema: ${(e as Error).message}`);
  }
  if (canonicalJson(JSON.parse(reportText)) !== reportText) fail('report JSON is not canonical');
  if (report.versionId !== versionId.toString()) fail(`report.versionId ${report.versionId} != ${versionId}`);
  for (const k of ['bundleHash', 'ciphertextHash', 'taskRoot', 'auditRoot'] as const) {
    if (!eq(report[k], version[k])) fail(`report.${k} ${report[k]} != on-chain ${version[k]}`);
  }
  checks.push('report binds versionId, bundleHash, ciphertextHash, taskRoot, auditRoot of the on-chain version');
  if (!eq(report.runtime.imageDigest, version.imageDigest)) checks.push(`NOTE: report runtime.imageDigest ${report.runtime.imageDigest} differs from listed imageDigest ${version.imageDigest}`);
  if (version.reportHash !== `0x${'00'.repeat(32)}`) {
    if (!eq(version.reportHash, reportHash)) fail(`on-chain reportHash ${version.reportHash} != ${reportHash}`);
    checks.push('reportHash matches the hash attached on-chain (attachReport verified the runner signature)');
  }
  let signer: Address | null = null;
  if (p.signature) {
    signer = await recoverEnvMarketSigner(envMarketDomain(ctx.chainId, ctx.market), 'PreviewReport', { versionId, bundleHash: version.bundleHash, reportHash }, p.signature as Hex);
    if (!eq(signer, report.signer)) fail(`EIP-712 signer ${signer} != report.signer ${report.signer}`);
    const isRunner = await marketRead<boolean>(ctx, 'isRunner', [signer]);
    if (!isRunner) fail(`signer ${signer} is not an authorized runner on-chain`);
    checks.push(`EIP-712 PreviewReport signature by ${signer}; isRunner(${signer}) = true on-chain`);
  } else if (opts.requireSignature) {
    fail('no signature provided');
  }
  if (!eq(report.attestation.signer, report.signer)) fail('attestation.signer != report.signer');
  checks.push(`attestation.kind = ${report.attestation.kind}${report.attestation.kind === 'none-local-dev' ? ' (LOCAL DEV: no TEE attestation; operator can read plaintext)' : ''}`);
  return { report, reportText, reportHash, signer, checks };
}

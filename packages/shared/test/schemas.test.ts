import { describe, expect, it } from 'vitest';
import {
  descriptionHash,
  manifestHash,
  parseDescription,
  parseManifest,
  parseReport,
  pass1Rounded,
  reportHash,
  roundPass1,
  serializeDescription,
  serializeManifest,
  serializeReport,
  sha256Hex,
  WITHHELD_EXPLANATION,
  type Manifest,
  type Report,
} from '../src/index.ts';

const h = (s: string) => sha256Hex(s);

export const sampleManifest: Manifest = {
  schemaVersion: '1',
  environmentType: 'coding',
  name: 'py-repair-kit',
  environmentVersion: '1.0.0',
  bundleDigest: h('payload'),
  imageDigest: h('image'),
  imageRef: 'python:3.12-slim@sha256:' + 'ab'.repeat(32),
  taskRoot: h('root'),
  taskCount: 5,
  auditRoot: h('audit'),
  auditTaskCount: 3,
  entrypoints: { reset: 'python -m harness reset', step: 'python -m harness step', grade: 'python -m harness grade', close: 'python -m harness close' },
  schemas: { observation: { type: 'object' }, action: { type: 'object' }, gradeResult: { type: 'object' } },
  grader: { entrypoint: 'grader/run.sh', dependencies: ['pytest==8.3.3'], version: '1', digest: h('grader'), externalJudge: null },
  resources: { cpu: 1, memoryMb: 1024, accelerator: null, diskMb: 512, episodeTimeoutSec: 300, actionBudget: 30, concurrency: 1 },
  determinism: { randomnessSources: [], seedPolicy: 'fixed seed 0', supportedRuntimes: ['linux/amd64'], resultsMayVary: false },
  networkPolicy: { mode: 'offline', externalDependencies: [] },
  referenceProtocol: {
    id: 'ref-v1',
    models: [{ requested: 'GLM 5.3', artifact: null }],
    harness: 'envmarket-harness@1',
    decoding: { temperature: 0, seed: 0, maxTokens: 4096 },
    taskSelection: 'all purchased tasks',
    actionBudget: 30,
    timeBudgetSec: 600,
    successRule: 'all hidden tests pass',
  },
  license: { id: 'EnvMarket-NonExclusive-1.0', summary: 'internal training and evaluation', exclusive: false, redistribution: false },
  provenance: { authors: ['seller'], upstreamSources: [], funders: [] },
  conflicts: { relatedParties: [], disclosures: [] },
  commercialTerms: {
    currency: 'USDC',
    decimals: 6,
    price: '2000000',
    perTaskAllocation: 'equal',
    deliveryWindowSec: 600,
    challengeWindowSec: 300,
    refundCapBps: 5000,
    collateral: '2000000',
  },
};

export const sampleReport: Report = {
  type: 'envmarket.report.v1',
  versionId: '1',
  environmentVersion: '1.0.0',
  bundleHash: h('b'),
  ciphertextHash: h('c'),
  taskRoot: h('t'),
  auditRoot: h('a'),
  protocol: {
    id: 'ref-v1',
    harnessDigest: h('harness'),
    promptDigest: h('prompt'),
    decoding: { temperature: 0, seed: 0, maxTokens: 4096 },
    actionBudget: 30,
    timeBudgetSec: 600,
    successRule: 'all hidden tests pass',
  },
  models: [
    {
      requested: 'GLM 5.3',
      resolved: 'accounts/fireworks/models/glm-4p6',
      provider: 'fireworks',
      status: 'run',
      purchased: { attempted: 5, solved: 3, pass1Rounded: 60 },
      audit: { attempted: 3, solved: 1, pass1Rounded: 35 },
      infraFailures: 0,
    },
    {
      requested: 'Kimi K3',
      resolved: null,
      provider: null,
      status: 'unavailable',
      purchased: { attempted: 0, solved: 0, pass1Rounded: null },
      audit: { attempted: 0, solved: 0, pass1Rounded: null },
      infraFailures: 0,
    },
  ],
  uncertainty: 'n=5 tasks; rounding to 5pp hides little',
  validator: {
    model: 'accounts/fireworks/models/deepseek-v3p1',
    promptVersion: 'validator-v1',
    promptHash: h('vp'),
    explanation: WITHHELD_EXPLANATION,
    screening: { passed: false, reasons: ['copied span'] },
  },
  jobs: [{ jobId: 'job-1', startedAt: '2026-09-10T12:00:00Z', finishedAt: '2026-09-10T12:05:00Z', status: 'succeeded' }],
  runtime: { imageDigest: h('image'), sandbox: 'docker --network none', network: 'none' },
  attestation: { kind: 'none-local-dev', appId: null, signer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', quoteDigest: null, verifyUrl: null },
  signer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  createdAt: '2026-09-10T12:06:00Z',
};

describe('pass@1 rounding', () => {
  it('rounds to nearest 5pp (half up) as integer percent', () => {
    expect(roundPass1(0)).toBe(0);
    expect(roundPass1(1)).toBe(100);
    expect(roundPass1(0.6)).toBe(60);
    expect(roundPass1(1 / 3)).toBe(35);
    expect(roundPass1(0.125)).toBe(15);
    expect(roundPass1(0.1249)).toBe(10);
    expect(() => roundPass1(1.2)).toThrow();
    expect(pass1Rounded(1, 3)).toBe(35);
    expect(pass1Rounded(1, 8)).toBe(15);
    expect(pass1Rounded(2, 3)).toBe(65);
    expect(pass1Rounded(0, 0)).toBe(null);
    for (let a = 1; a <= 40; a++) for (let s = 0; s <= a; s++) expect(pass1Rounded(s, a)).toBe(roundPass1(s / a));
  });
});

describe('manifest', () => {
  it('parses the sample and hashes canonically', () => {
    const m = parseManifest(sampleManifest);
    expect(manifestHash(m)).toBe(sha256Hex(serializeManifest(m)));
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
  it('rejects bad fields', () => {
    expect(() => parseManifest({ ...sampleManifest, taskCount: 0 })).toThrow();
    expect(() => parseManifest({ ...sampleManifest, bundleDigest: '0x1234' })).toThrow();
    expect(() => parseManifest({ ...sampleManifest, environmentType: 'vr' })).toThrow();
    const { commercialTerms: _c, ...rest } = sampleManifest;
    expect(() => parseManifest(rest)).toThrow();
  });
});

describe('report', () => {
  it('parses the sample; reportHash is sha256 of canonical JSON and stable', () => {
    const r = parseReport(sampleReport);
    const json = serializeReport(r);
    expect(reportHash(r)).toBe(sha256Hex(json));
    expect(reportHash(json)).toBe(reportHash(r));
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(sampleReport);
    expect(Object.keys(reordered as object)[0]).toBe('createdAt');
    expect(reportHash(parseReport(reordered))).toBe(reportHash(r));
  });
  it('enforces consistency and limits', () => {
    const bad = structuredClone(sampleReport);
    bad.models[0]!.purchased.pass1Rounded = 55;
    expect(() => parseReport(bad)).toThrow(/inconsistent/);
    const long = structuredClone(sampleReport);
    long.validator.explanation = 'word '.repeat(121);
    expect(() => parseReport(long)).toThrow(/explanation/);
    const kind = structuredClone(sampleReport) as any;
    kind.attestation.kind = 'mock';
    expect(() => parseReport(kind)).toThrow();
    const extra = { ...sampleReport, extra: 1 };
    expect(() => parseReport(extra)).toThrow();
  });
});

describe('description', () => {
  const d = {
    schemaVersion: '1',
    title: 'Python repair kit',
    environmentVersion: '1.0.0',
    claims: [
      { id: 'C1', text: 'Contains exactly 5 purchased repair tasks.', category: 'tasks', checkable: true },
      { id: 'C2', text: 'All tests run offline with pytest 8.3.3.', category: 'network', checkable: true },
    ],
  };
  it('parses and hashes', () => {
    const p = parseDescription(d);
    expect(descriptionHash(p)).toBe(sha256Hex(serializeDescription(p)));
  });
  it('rejects duplicates, non-checkable claims, bad ids', () => {
    expect(() => parseDescription({ ...d, claims: [d.claims[0], d.claims[0]] })).toThrow(/duplicate/);
    expect(() => parseDescription({ ...d, claims: [{ ...d.claims[0], checkable: false }] })).toThrow();
    expect(() => parseDescription({ ...d, claims: [{ ...d.claims[0], id: '1' }] })).toThrow();
    expect(() => parseDescription({ ...d, claims: [] })).toThrow();
  });
});

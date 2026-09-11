#!/usr/bin/env tsx
/**
 * Local end-to-end test of the TEE service on anvil (chainId 31337). Never touches a public network.
 *
 *   cd services/tee && npm run e2e
 *
 * 1. starts anvil (port E2E_ANVIL_PORT, default 8555) and deploys the contracts with the repo's
 *    forge Deploy script (runner/relay/verifier = the service's local-dev signer, RUNNER_PK); the
 *    deployment file goes to services/tee/.data-e2e/deployments/31337.json (not the repo's
 *    deployments/, so parallel anvil runs of other packages are not clobbered)
 * 2. packages seller-workspace/py-repair-kit with the seller agent's packager (agents/src/seller)
 * 3. runs the service in local-dev mode (child process; attestation.kind = none-local-dev)
 * 4. seller uploads (keys ECIES-wrapped to the TEE), deposits collateral, creates the listing
 * 5. preview: real inference (Fireworks if FIREWORKS_API_KEY is set, else local Ollama harness
 *    check), signed report attached on-chain, second request served from cache
 * 6. buyer buys → relay delivers on-chain → buyer fetches wrapper + wrapped key, decrypts the
 *    ciphertext and checks bundleHash; service restart keeps serving the same delivery
 * 7. BrokenOrHashMismatch dispute → mechanical verifier → resolveMechanical on-chain
 * 8. FalseDescription dispute on a second purchase → jurors selected on-chain → a seated juror
 *    fetches the case packet (non-seated address and replayed nonce rejected)
 * 9. (E2E_BROKEN_VARIANT=1) a second version whose T3 hidden tests fail on the reference solution →
 *    preview → buy → BrokenOrHashMismatch dispute is UPHELD for exactly that task
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http as viemHttp, parseEventLogs, recoverMessageAddress, type Abi, type Address, type Hex } from 'viem';
import { marketAbi as loadMarketAbi } from '../src/chain.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil as anvilChain } from 'viem/chains';
import {
  canonicalJson,
  decryptFile,
  encryptFile,
  envMarketDomain,
  evidenceAuthMessage,
  fromBase64,
  loadAbi,
  loadEnv,
  parseDeliveryWrapper,
  parseReport,
  readTar,
  sha256Hex,
  toBase64,
  unwrapKeyAsync,
  UPLOAD_KEYWRAP_INFO,
  verifyEnvMarketSignature,
  wrapKeyAsync,
} from '@envmarket/shared';
import { packageEnvironment, type PackageResult } from '../../../agents/src/seller/package.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEE_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(TEE_DIR, '..', '..');
const E2E = path.join(TEE_DIR, '.data-e2e');
const FOUNDRY = path.join(process.env.HOME ?? '', '.foundry', 'bin');
const ANVIL_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8555);
const TEE_PORT = Number(process.env.E2E_TEE_PORT ?? 8797);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const TEE = `http://127.0.0.1:${TEE_PORT}`;
const PRICE = 100_000_000n; // 100 tUSDC
const COLLATERAL = 100_000_000n;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  log('ok -', msg);
}

// ------------------------------------------------------------------------------ processes
const children: ChildProcess[] = [];
process.on('exit', () => children.forEach((c) => c.kill('SIGKILL')));
process.on('SIGINT', () => process.exit(130));

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}

function httpJson(method: string, url: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = text;
        try {
          json = JSON.parse(text);
        } catch {
          /* raw */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function httpBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ------------------------------------------------------------------------------ setup
const cfg = loadEnv({ cwd: ROOT, chainId: 31337 });
const K = cfg.keys;
for (const r of ['deployer', 'seller', 'buyer', 'buyer2', 'runner', 'juror1', 'juror2', 'juror3'] as const) if (!K[r]) throw new Error(`.env is missing ${r.toUpperCase()}_PK`);
const enc = cfg.encKeys;
if (!enc.buyer || !enc.buyer2) throw new Error('.env is missing BUYER_ENC_SK/PK or BUYER2_ENC_SK/PK');
const acct = (r: keyof typeof K) => privateKeyToAccount(K[r]!);
const TEE_SIGNER = acct('runner').address;
const useFireworks = !!cfg.env.FIREWORKS_API_KEY && process.env.E2E_LLM !== 'ollama';

const publicClient = createPublicClient({ chain: anvilChain, transport: viemHttp(RPC) });
const marketAbi = loadMarketAbi(ROOT);
const tokenAbi = loadAbi('TestUSDC') as Abi;
let MARKET: Address;
let TOKEN: Address;

async function send(role: keyof typeof K, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const account = acct(role);
  const wallet = createWalletClient({ chain: anvilChain, transport: viemHttp(RPC), account });
  const { request, result } = await publicClient.simulateContract({ address, abi, functionName, args, account } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return { receipt, result };
}
const readM = <T>(functionName: string, args: unknown[] = []) => publicClient.readContract({ address: MARKET, abi: marketAbi, functionName, args } as never) as Promise<T>;
const rpc = (method: string, params: unknown[]) => httpJson('POST', RPC, { jsonrpc: '2.0', id: 1, method, params });

function startAnvil(): Promise<void> {
  const a = spawn(path.join(FOUNDRY, 'anvil'), ['--port', String(ANVIL_PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  children.push(a);
  return waitFor('anvil', async () => (await rpc('eth_chainId', [])).json?.result === '0x7a69', 20_000, 300).then(() => undefined);
}

function deploy(): void {
  const runFile = path.join(ROOT, 'contracts', 'broadcast', 'Deploy.s.sol', '31337', 'run-latest.json');
  const env = {
    PATH: `${FOUNDRY}:${process.env.PATH}`,
    HOME: process.env.HOME ?? '',
    DEPLOYER_PK: K.deployer!,
    PARAM_SET: 'demo',
    TOKEN_ADDR: '',
    RUNNER_ADDR: TEE_SIGNER,
    RELAY_ADDR: TEE_SIGNER,
    VERIFIER_ADDR: TEE_SIGNER,
    SELLER_ADDR: acct('seller').address,
    BUYER_ADDR: acct('buyer').address,
    BUYER2_ADDR: acct('buyer2').address,
    JUROR1_ADDR: acct('juror1').address,
    JUROR2_ADDR: acct('juror2').address,
    JUROR3_ADDR: acct('juror3').address,
  };
  const f = spawnSync(path.join(FOUNDRY, 'forge'), ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC, '--broadcast'], { cwd: path.join(ROOT, 'contracts'), env, encoding: 'utf8' });
  if (f.status !== 0) throw new Error(`forge deploy failed:\n${f.stdout}\n${f.stderr}`);
  const out = path.join(E2E, 'deployments', '31337.json');
  const w = spawnSync(process.execPath, [path.join(ROOT, 'contracts', 'scripts', 'write-deployment.mjs'), runFile, RPC, out], { encoding: 'utf8' });
  if (w.status !== 0) throw new Error(`write-deployment failed:\n${w.stdout}\n${w.stderr}`);
  const d = JSON.parse(fs.readFileSync(out, 'utf8')) as { market: string; token: string; startBlock: number };
  MARKET = getAddress(d.market);
  TOKEN = getAddress(d.token);
}

let tee: ChildProcess | null = null;
const teeLog = path.join(E2E, 'tee.log');
async function startTee(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'MNEMONIC' && k !== 'MARKET_ADDRESS') env[k] = v;
  Object.assign(env, {
    CHAIN_ID: '31337',
    RPC_URL: RPC,
    DEPLOYMENTS_DIR: path.join(E2E, 'deployments'),
    DATA_DIR: path.join(E2E, 'tee-data'),
    PORT: String(TEE_PORT),
    HOST: '127.0.0.1',
    PUBLIC_URL: TEE,
    SUBMIT_TXS: '1',
    WATCHER: '1',
    POLL_MS: '1000',
    LLM_PROVIDER: useFireworks ? 'fireworks' : 'ollama',
    PREVIEW_CONCURRENCY: process.env.PREVIEW_CONCURRENCY ?? (useFireworks ? '7' : '1'),
    EPISODE_TIME_SEC: process.env.EPISODE_TIME_SEC ?? (useFireworks ? '300' : '900'),
    LOG_LEVEL: 'info',
  });
  const out = fs.openSync(teeLog, 'a');
  tee = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: TEE_DIR, env, stdio: ['ignore', out, out] });
  children.push(tee);
  await waitFor('TEE /health', async () => (await httpJson('GET', `${TEE}/health`)).status === 200, 60_000, 500);
}
async function stopTee(): Promise<void> {
  if (!tee) return;
  const t = tee;
  tee = null;
  await new Promise<void>((resolve) => {
    t.once('exit', () => resolve());
    t.kill('SIGTERM');
    setTimeout(() => t.kill('SIGKILL'), 5000);
  });
}

// ------------------------------------------------------------------------------ flows
async function uploadBody(pkg: PackageResult, encPubKey: Hex) {
  const out = pkg.outDir;
  const L = pkg.listing;
  const bundleEnc = new Uint8Array(fs.readFileSync(path.join(out, L.files.bundleCiphertext)));
  const auditEnc = new Uint8Array(fs.readFileSync(path.join(out, L.files.auditCiphertext)));
  const keys = JSON.parse(fs.readFileSync(path.join(out, 'private', 'keys.json'), 'utf8')) as { bundleKey: Hex; auditKey: Hex };
  const salts = new Uint8Array(fs.readFileSync(path.join(out, 'private', 'salts.json')));
  const salt = sha256Hex(bundleEnc);
  const text = (p: string | null) => (p ? fs.readFileSync(path.join(out, p), 'utf8') : undefined);
  return {
    encryptedBundle: toBase64(bundleEnc),
    encryptedAudit: toBase64(auditEnc),
    wrappedBundleKey: toBase64(await wrapKeyAsync({ key: keys.bundleKey, recipientPublicKey: encPubKey, wrapperHash: salt, info: UPLOAD_KEYWRAP_INFO })),
    wrappedAuditKey: toBase64(await wrapKeyAsync({ key: keys.auditKey, recipientPublicKey: encPubKey, wrapperHash: salt, info: UPLOAD_KEYWRAP_INFO })),
    encryptedSalts: toBase64(encryptFile(keys.auditKey, salts)),
    publicDocs: {
      'description.json': text(L.files.description),
      'description.md': text(L.files.descriptionMd),
      'manifest.json': text(L.files.manifest),
      license: { base64: toBase64(new Uint8Array(fs.readFileSync(path.join(out, L.files.license)))) },
    },
    claims: { ...L.versionInput, price: undefined, collateral: undefined, deliveryWindow: undefined, challengeWindow: undefined, uri: undefined, environmentVersion: L.environmentVersion },
  };
}

async function listVersion(pkg: PackageResult, listingId: bigint | null): Promise<bigint> {
  const v = pkg.listing.versionInput;
  const input = {
    bundleHash: v.bundleHash,
    ciphertextHash: v.ciphertextHash,
    imageDigest: v.imageDigest,
    descriptionHash: v.descriptionHash,
    manifestHash: v.manifestHash,
    licenseHash: v.licenseHash,
    taskRoot: v.taskRoot,
    auditRoot: v.auditRoot,
    taskCount: v.taskCount,
    auditTaskCount: v.auditTaskCount,
    price: BigInt(v.price),
    collateral: BigInt(v.collateral),
    deliveryWindow: v.deliveryWindow,
    challengeWindow: v.challengeWindow,
    uri: `${TEE}/blobs/`,
  };
  const { receipt } = listingId === null ? await send('seller', MARKET, marketAbi, 'createListing', [input]) : await send('seller', MARKET, marketAbi, 'newVersion', [listingId, input]);
  const ev = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: 'VersionCreated' })[0] as unknown as { args: { versionId: bigint; listingId: bigint } };
  return ev.args.versionId;
}

async function preview(versionId: bigint, pkg: PackageResult, reuseOf?: { versionId: bigint; report: ReturnType<typeof parseReport> }) {
  const unpaid = await httpJson('POST', `${TEE}/preview/${versionId}`);
  check(unpaid.status === 402, `preview refused before the seller pays (HTTP ${unpaid.status})`);
  const q = await httpJson('GET', `${TEE}/preview/quote/${versionId}`);
  check(q.status === 200 && sha256Hex(canonicalJson(q.json.quote)) === q.json.quoteHash, 'signed quote: quoteHash = sha256(canonical quote JSON)');
  check((await recoverMessageAddress({ message: { raw: q.json.quoteHash }, signature: q.json.signature })) === TEE_SIGNER, 'quote signed by the TEE signer');
  const fee = BigInt(q.json.quote.feeUsdc);
  log(`quote v${versionId}: cached=${q.json.quote.cached} episodes=${q.json.quote.episodes} est $${q.json.quote.estimatedCostUsd} fee ${fee} (${q.json.quote.costModel})`);
  if (reuseOf) check(q.json.quote.cached === true && q.json.quote.episodes === 0 && q.json.quote.estimatedCostUsd === 0, 'same bundle + protocol: quote is cached with ~zero inference cost');
  if (fee > 0n) await send('seller', TOKEN, tokenAbi, 'approve', [MARKET, fee]);
  await send('seller', MARKET, marketAbi, 'requestPreview', [versionId, fee, q.json.quoteHash]);
  log(`preview v${versionId}: ${reuseOf ? 'expecting reuse of the cached run' : `running the reference panel (${useFireworks ? 'Fireworks' : 'local Ollama harness check'})`} …`);
  const start = await httpJson('POST', `${TEE}/preview/${versionId}?async=1`);
  check(start.status === 202 || start.status === 200, `preview accepted (HTTP ${start.status}${start.status >= 400 ? ' ' + JSON.stringify(start.json).slice(0, 400) : ''})`);
  const done = await waitFor(
    'preview report',
    async () => {
      const r = await httpJson('GET', `${TEE}/reports/${versionId}`);
      if (r.status === 500) throw new Error(`preview failed: ${JSON.stringify(r.json).slice(0, 1500)}`);
      return r.status === 200 ? r.json : null;
    },
    90 * 60_000,
    10_000,
  ).catch((e) => {
    throw e;
  });
  const report = parseReport(done.reportJson);
  check(sha256Hex(done.reportJson) === done.reportHash, 'reportHash = sha256(canonical report.json)');
  check(report.bundleHash === pkg.bundleHash && report.versionId === versionId.toString(), 'report binds versionId and bundleHash');
  const ok = await verifyEnvMarketSignature(envMarketDomain(31337, MARKET), 'PreviewReport', { versionId, bundleHash: pkg.bundleHash, reportHash: done.reportHash }, done.signature, TEE_SIGNER);
  check(ok, 'EIP-712 PreviewReport signature recovers to the TEE signer');
  const onchain = (await readM<{ reportHash: Hex }>('getVersion', [versionId])).reportHash;
  check(onchain.toLowerCase() === done.reportHash, 'report attached on-chain (attachReport)');
  check(report.attestation.kind === 'none-local-dev', 'local run is labeled attestation.kind = none-local-dev');
  check(report.runtime.network === 'none' && /docker|linux-root/.test(report.runtime.sandbox), `sandbox recorded: ${report.runtime.sandbox}`);
  for (const m of report.models) log(`   model ${m.requested} → ${m.resolved ?? '-'} [${m.status}] purchased ${m.purchased.solved}/${m.purchased.attempted} (${m.purchased.pass1Rounded ?? '-'}%) audit ${m.audit.solved}/${m.audit.attempted} infra ${m.infraFailures}`);
  log(`   validator ${report.validator.model}: screening ${report.validator.screening.passed ? 'passed' : 'FAILED ' + report.validator.screening.reasons.join('; ')} — "${report.validator.explanation}"`);
  check(report.jobs.length === report.models.reduce((n, m) => n + m.purchased.attempted + m.audit.attempted, 0), 'every scheduled job is listed (none dropped)');
  if (useFireworks) check(report.models.filter((m) => m.status === 'run').length === 3 && report.models.every((m) => m.provider === 'fireworks'), 'all three pinned panel models ran on Fireworks');
  const again = await httpJson('POST', `${TEE}/preview/${versionId}`);
  check(again.status === 200 && again.json.cached === true && again.json.reportHash === done.reportHash, 'second preview request served from cache');
  if (reuseOf) {
    check(JSON.stringify(report.jobs) === JSON.stringify(reuseOf.report.jobs) && JSON.stringify(report.models) === JSON.stringify(reuseOf.report.models), 'reused report keeps the original jobIds, run dates and scores');
    const cf = (report as unknown as { cachedFrom?: { originalVersionId: string } }).cachedFrom;
    check(cf ? cf.originalVersionId === reuseOf.versionId.toString() : report.uncertainty.includes(`version ${reuseOf.versionId}`), `report marks reuse (${cf ? 'cachedFrom' : 'disclosure note; shared schema has no cachedFrom yet'})`);
    check(report.createdAt !== reuseOf.report.createdAt && done.reportHash !== undefined, 'reused report is freshly signed for the new versionId');
  }
  return report;
}

async function buyAndReceive(buyer: 'buyer' | 'buyer2', versionId: bigint, pkg: PackageResult): Promise<bigint> {
  const encKeys = enc[buyer]!;
  await send(buyer, TOKEN, tokenAbi, 'approve', [MARKET, PRICE]);
  const { receipt } = await send(buyer, MARKET, marketAbi, 'buy', [versionId, encKeys.publicKey, PRICE]);
  const pid = (parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: 'Purchased' })[0] as unknown as { args: { purchaseId: bigint } }).args.purchaseId;
  log(`${buyer} bought v${versionId}: purchase ${pid}; waiting for the relay …`);
  await waitFor('Delivered on-chain', async () => Number((await readM<{ state: number }>('getPurchase', [pid])).state) === 2, 120_000);
  check(true, `purchase ${pid} Delivered on-chain by the relay`);
  const d = await httpJson('GET', `${TEE}/deliveries/${pid}`);
  check(d.status === 200, `GET /deliveries/${pid}`);
  const w = parseDeliveryWrapper(d.json.wrapper);
  const p = await readM<{ wrapperHash: Hex; wrappedKeyHash: Hex; buyer: Address }>('getPurchase', [pid]);
  check(w.wrapperHash === p.wrapperHash.toLowerCase() && sha256Hex(fromBase64(d.json.wrappedKey)) === p.wrappedKeyHash.toLowerCase(), 'wrapperHash / wrappedKeyHash match the on-chain receipt');
  check(w.wrapper.buyer === p.buyer.toLowerCase() && w.wrapper.buyerEncPubKey === encKeys.publicKey.toLowerCase() && w.wrapper.bundleHash === pkg.bundleHash, 'wrapper binds buyer, encryption key and bundle');
  const key = await unwrapKeyAsync({ blob: fromBase64(d.json.wrappedKey), recipientSecretKey: encKeys.secretKey, wrapperHash: w.wrapperHash });
  const ct = await httpBytes(d.json.ciphertextUrl);
  check(sha256Hex(ct) === pkg.listing.versionInput.ciphertextHash, 'downloaded ciphertext matches ciphertextHash');
  const tar = decryptFile(key, ct);
  check(sha256Hex(tar) === pkg.bundleHash, 'buyer decrypts the bundle and sha256 == bundleHash');
  const paths = readTar(tar).map((e) => e.path);
  check(!paths.some((x) => /audit-tasks|(^|\/)A[12](\/|$)|salts\.json|keys\.json/.test(x)), 'buyer archive has no audit tasks, salts or keys');
  check(paths.some((x) => x.startsWith('tasks/T1/tests/')) && paths.some((x) => x.startsWith('solutions/')), 'buyer archive has hidden tests and reference solutions');
  return pid;
}

async function mechanicalDispute(pid: bigint, taskIndex: number, expectUpheld: boolean): Promise<void> {
  const mask = 1n << BigInt(taskIndex);
  const [, bond] = await readM<[bigint, bigint]>('quoteDispute', [pid, mask]);
  const ev = await httpJson('POST', `${TEE}/evidence-upload`, { content: `Task at index ${taskIndex} appears broken under the declared runtime.` });
  check(ev.status === 200, 'buyer evidence stored privately (POST /evidence-upload)');
  await send('buyer', TOKEN, tokenAbi, 'approve', [MARKET, bond]);
  const { receipt } = await send('buyer', MARKET, marketAbi, 'openDispute', [pid, 1, mask, ev.json.evidenceHash]);
  const did = (parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: 'DisputeOpened' })[0] as unknown as { args: { disputeId: bigint } }).args.disputeId;
  log(`BrokenOrHashMismatch dispute ${did} opened on task bit ${taskIndex}; waiting for the mechanical verifier …`);
  const [d] = await waitFor('dispute resolved', async () => {
    const x = await readM<[{ status: number; verdict: number; confirmedMask: bigint; findingsHash: Hex }, unknown]>('getDispute', [did]);
    return Number(x[0].status) === 3 ? x : null;
  }, 15 * 60_000, 3000);
  const upheld = Number(d.verdict) === 1;
  check(upheld === expectUpheld, `verifier verdict: ${upheld ? 'UPHELD' : 'rejected'} (expected ${expectUpheld ? 'upheld' : 'rejected'})`);
  if (expectUpheld) check(d.confirmedMask === mask, `confirmedMask = ${mask}`);
  const f = await httpJson('GET', `${TEE}/findings/${did}`);
  check(f.status === 200 && sha256Hex(canonicalJson(f.json.findings)) === d.findingsHash.toLowerCase(), 'public findings JSON hashes to the on-chain findingsHash');
  const blob = await httpBytes(`${TEE}/blobs/${d.findingsHash.slice(2)}`);
  check(sha256Hex(blob) === d.findingsHash.toLowerCase(), 'findings retrievable by sha256 from the blob store');
  log('   findings:', JSON.stringify(f.json.findings.result).slice(0, 600));
}

async function falseDescriptionEvidence(versionId: bigint, pkg: PackageResult): Promise<void> {
  for (const j of ['juror1', 'juror2', 'juror3'] as const) {
    await send(j, TOKEN, tokenAbi, 'approve', [MARKET, 20_000_000n]);
    await send(j, MARKET, marketAbi, 'depositJurorStake', [20_000_000n]);
  }
  const pid = await buyAndReceive('buyer2', versionId, pkg);
  const evidence = JSON.stringify({ type: 'envmarket.evidence.v1', purchaseId: pid.toString(), claimIds: ['C10'], text: 'Claim C10 says every purchased hidden test suite has at least 8 test cases; I believe the first task has fewer.' });
  const ev = await httpJson('POST', `${TEE}/evidence-upload`, { content: evidence });
  check(ev.json.evidenceHash === sha256Hex(evidence), 'evidenceHash = sha256(evidence bytes)');
  const [, bond] = await readM<[bigint, bigint]>('quoteDispute', [pid, 1n]);
  await send('buyer2', TOKEN, tokenAbi, 'approve', [MARKET, bond]);
  const { receipt } = await send('buyer2', MARKET, marketAbi, 'openDispute', [pid, 2, 1n, ev.json.evidenceHash]);
  const did = (parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: 'DisputeOpened' })[0] as unknown as { args: { disputeId: bigint } }).args.disputeId;
  await rpc('anvil_mine', ['0x3']);
  await send('deployer', MARKET, marketAbi, 'selectJurors', [did]);
  const [, seats] = await readM<[unknown, Array<{ juror: Address }>]>('getDispute', [did]);
  const seated = seats.slice(0, 3).map((s) => s.juror.toLowerCase());
  const jurorRole = (['juror1', 'juror2', 'juror3'] as const).find((j) => seated.includes(acct(j).address.toLowerCase()))!;
  check(!!jurorRole, `jurors seated on-chain for FalseDescription dispute ${did}`);
  const sign = async (role: keyof typeof K, nonce: string) => {
    const a = acct(role);
    const message = evidenceAuthMessage({ chainId: 31337, market: MARKET, disputeId: did, juror: a.address, nonce, expiresAt: Math.floor(Date.now() / 1000) + 600 });
    return { juror: a.address, message, signature: await a.signMessage({ message }) };
  };
  const auth = await sign(jurorRole, `n-${Date.now()}`);
  const r = await httpJson('POST', `${TEE}/evidence/${did}`, auth, 600_000);
  check(r.status === 200, `seated juror fetches the case packet (HTTP ${r.status}${r.status !== 200 ? ' ' + JSON.stringify(r.json).slice(0, 300) : ''})`);
  const pk = r.json.packet;
  check(pk.description.verified && pk.disputedClaims.some((c: { id: string }) => c.id === 'C10'), 'packet has the frozen description and the disputed claim C10');
  check(pk.evidence.verified && pk.evidence.text === evidence, 'packet has the buyer evidence (hash-verified)');
  const t1 = pk.bundleFacts.tasks.find((t: { taskId: string }) => t.taskId === 'T1');
  check(t1 && t1.masked && typeof t1.hiddenTestCount === 'number' && t1.hiddenTestCount > 0, `mechanical fact: T1 has ${t1?.hiddenTestCount} hidden test cases`);
  check(!/audit-tasks|"A1"|"A2"/.test(JSON.stringify(pk)), 'packet contains no audit tasks');
  const replay = await httpJson('POST', `${TEE}/evidence/${did}`, auth);
  check(replay.status === 401, 'replayed challenge rejected');
  const outsider = await httpJson('POST', `${TEE}/evidence/${did}`, await sign('buyer', `n-${Date.now()}-x`));
  check(outsider.status === 403, 'non-seated address rejected');
}

function brokenWorkspace(): string {
  const src = path.join(ROOT, 'seller-workspace', 'py-repair-kit');
  const dst = path.join(E2E, 'broken-ws');
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.includes('__pycache__') });
  const t3tests = path.join(dst, 'tasks', 'T3', 'tests');
  const f = fs.readdirSync(t3tests).find((x) => x.endsWith('.py') && x.startsWith('test_'))!;
  fs.appendFileSync(path.join(t3tests, f), '\n\ndef test_seeded_defect_for_e2e():\n    assert 1 == 2, "deliberately broken hidden test (e2e broken variant)"\n');
  const d = JSON.parse(fs.readFileSync(path.join(dst, 'listing', 'description.json'), 'utf8'));
  d.environmentVersion = 'py-repair-kit@1.0.0-broken-e2e';
  fs.writeFileSync(path.join(dst, 'listing', 'description.json'), JSON.stringify(d, null, 1));
  const m = JSON.parse(fs.readFileSync(path.join(dst, 'listing', 'manifest.template.json'), 'utf8'));
  m.environmentVersion = d.environmentVersion;
  fs.writeFileSync(path.join(dst, 'listing', 'manifest.template.json'), JSON.stringify(m, null, 1));
  return dst;
}

// ------------------------------------------------------------------------------ main
async function main(): Promise<void> {
  fs.rmSync(E2E, { recursive: true, force: true });
  fs.mkdirSync(E2E, { recursive: true });
  log(`inference: ${useFireworks ? 'Fireworks (real panel)' : 'local Ollama harness check (no FIREWORKS_API_KEY)'}`);
  await startAnvil();
  for (const r of ['deployer', 'seller', 'buyer', 'buyer2', 'runner', 'juror1', 'juror2', 'juror3'] as const) await rpc('anvil_setBalance', [acct(r).address, '0x56BC75E2D63100000']);
  deploy();
  check(await readM<boolean>('isRunner', [TEE_SIGNER]) && (await readM<boolean>('isRelay', [TEE_SIGNER])) && (await readM<boolean>('isVerifier', [TEE_SIGNER])), `contracts deployed at ${MARKET}; TEE signer ${TEE_SIGNER} holds runner/relay/verifier`);

  const pkg = packageEnvironment({ workspace: path.join(ROOT, 'seller-workspace', 'py-repair-kit'), outDir: path.join(E2E, 'seller', 'v1'), force: true, price: PRICE, collateral: COLLATERAL, currency: 'tUSDC', decimals: 6 });
  log(`packaged ${pkg.listing.environmentVersion}: bundleHash ${pkg.bundleHash}`);

  await startTee();
  const health = (await httpJson('GET', `${TEE}/health`)).json;
  check(health.signer === TEE_SIGNER && health.attestation.kind === 'none-local-dev' && /^0x[0-9a-f]{64}$/.test(health.encPubKey), 'TEE service up in local-dev mode (none-local-dev), exposes its X25519 key');

  const up = await httpJson('POST', `${TEE}/seller/upload`, await uploadBody(pkg, health.encPubKey), 900_000);
  check(up.status === 200, `seller upload accepted (HTTP ${up.status}${up.status !== 200 ? ' ' + JSON.stringify(up.json).slice(0, 800) : ''})`);
  check(up.json.stored.bundleHash === pkg.bundleHash && up.json.stored.taskRoot === pkg.listing.versionInput.taskRoot && up.json.stored.auditRoot === pkg.listing.versionInput.auditRoot, 'TEE recomputed bundleHash, taskRoot and auditRoot');
  check(up.json.preflight.ok, `preflight: deps install, grader imports, hidden tests collect, reference solutions pass (${up.json.preflight.purchased.map((t: { taskId: string; hiddenTestCount: number }) => `${t.taskId}:${t.hiddenTestCount}`).join(' ')})`);
  const bad = await httpJson('POST', `${TEE}/seller/upload`, { ...(await uploadBody(pkg, health.encPubKey)), claims: { bundleHash: sha256Hex('wrong') } });
  check(bad.status === 400 && bad.json.checks.some((c: { name: string; ok: boolean }) => c.name === 'claim.bundleHash' && !c.ok), 'upload with a false bundleHash claim is rejected');

  await send('seller', TOKEN, tokenAbi, 'approve', [MARKET, 3n * COLLATERAL]);
  await send('seller', MARKET, marketAbi, 'depositCollateral', [3n * COLLATERAL]);
  const versionId = await listVersion(pkg, null);
  log(`listing created: version ${versionId}`);

  const report1 = await preview(versionId, pkg);

  // run inference once per environment: a new version with the same bundle reuses the cached run
  const listingId1 = (await readM<{ listingId: bigint }>('getVersion', [versionId])).listingId;
  const vReuse = await listVersion(pkg, listingId1);
  const tReuse = Date.now();
  await preview(vReuse, pkg, { versionId, report: report1 });
  check(Date.now() - tReuse < 120_000, `cached preview for v${vReuse} took ${((Date.now() - tReuse) / 1000).toFixed(0)}s (no inference)`);
  const exp = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/export-preview-cache.ts', '--data-dir', path.join(E2E, 'tee-data'), '--to-url', TEE, '--out', path.join(E2E, 'cache-export'), '--post'], {
    cwd: TEE_DIR,
    env: { ...process.env, MNEMONIC: '' },
    encoding: 'utf8',
  });
  check(exp.status === 0 && /-> 200 /.test(exp.stdout), `sealed preview-cache export re-imported over HTTP (${exp.stdout.trim().split('\n').pop()?.slice(0, 160)})`);

  const pid = await buyAndReceive('buyer', versionId, pkg);

  log('restarting the TEE service (persistence + idempotent watcher) …');
  await stopTee();
  await startTee();
  const again = await httpJson('GET', `${TEE}/deliveries/${pid}`);
  check(again.status === 200 && again.json.wrapperHash === (await readM<{ wrapperHash: Hex }>('getPurchase', [pid])).wrapperHash.toLowerCase(), 'after restart the same delivery is served (encrypted records survive)');
  check((await httpJson('GET', `${TEE}/reports/${versionId}`)).status === 200, 'after restart the cached report is served');

  await mechanicalDispute(pid, 1, false);
  await falseDescriptionEvidence(versionId, pkg);

  if (process.env.E2E_BROKEN_VARIANT === '1') {
    log('broken variant: T3 has a hidden test that fails on the reference solution');
    const pkg2 = packageEnvironment({ workspace: brokenWorkspace(), outDir: path.join(E2E, 'seller', 'v2'), force: true, price: PRICE, collateral: COLLATERAL, currency: 'tUSDC', decimals: 6 });
    const up2 = await httpJson('POST', `${TEE}/seller/upload`, await uploadBody(pkg2, health.encPubKey), 900_000);
    check(up2.status === 200 && up2.json.preflight.ok === false && up2.json.preflight.buildOk !== false, 'broken bundle uploads; preflight reports the failing reference solution');
    const listingId = (await readM<{ listingId: bigint }>('getVersion', [versionId])).listingId;
    const v2 = await listVersion(pkg2, listingId);
    await preview(v2, pkg2);
    const pid2 = await buyAndReceive('buyer', v2, pkg2);
    await mechanicalDispute(pid2, pkg2.listing.taskIds.indexOf('T3'), true);
  }

  log(`ALL CHECKS PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main()
  .then(async () => {
    await stopTee();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`\n[e2e] FAILED: ${(e as Error).stack ?? e}`);
    try {
      console.error('--- tee.log (tail) ---\n' + fs.readFileSync(teeLog, 'utf8').split('\n').slice(-40).join('\n'));
    } catch {
      /* no log */
    }
    await stopTee();
    process.exit(1);
  });

/**
 * End-to-end juror integration test on a LOCAL anvil (chainId 31337 only; refuses anything else).
 *
 *   tsx scripts/anvil-integration.ts
 *
 * 1. Starts anvil (port ANVIL_PORT, default 8546, 1 s blocks) and deploys EnvMarket + TestUSDC with
 *    contracts/script/Deploy.s.sol + contracts/scripts/write-deployment.mjs (deployment file goes to
 *    a temp dir so the repo's deployments/31337.json is never touched).
 * 2. Sets up a real listing (hashes of the real seller-workspace/py-repair-kit files, AES-GCM
 *    encrypted bundle, runner-signed report hash), purchase, relay-signed delivery, and the seeded
 *    FalseDescription dispute on claim C10 (taskMask 0x2) using the repo .env keys.
 * 3. Registers the three jurors via the real CLI and runs them with run-all (real LLM inference:
 *    Fireworks if FIREWORKS_API_KEY is set, else local Ollama). Kills juror 2 right after its commit
 *    to prove restart safety (it must reveal from its persisted salt).
 * 4. Waits for on-chain resolution and checks verdict, refund, bond, juror rewards/slashes,
 *    withdrawals, commitments vs Solidity commitmentFor, rationale publication, and the accounting
 *    invariant.
 *
 * Evidence: if TEE_URL points at a running services/tee with POST /evidence, that is used. Otherwise
 * a TEST HARNESS evidence server (clearly labeled in the packet) serves a case packet built from the
 * real product files (pytest collection counts of the real hidden tests) and verifies the juror's
 * EIP-191 auth + on-chain seat, and accepts PUT /blobs for rationales.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDeliveryWrapper,
  buildTaskTree,
  canonicalJson,
  canonicalTarOfDir,
  encryptFile,
  ensureAllowance,
  envMarketDomain,
  graderDigestOfDir,
  loadAbi,
  loadEnv,
  makeClients,
  randomKey,
  randomSalt,
  sha256Hex,
  signDeliveryReceipt,
  signPreviewReport,
  taskHashOfDir,
  verifyEvidenceAuth,
  wrapKey,
  writeAndWait,
  type Clients,
} from '@envmarket/shared';
import { createPublicClient, formatUnits, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { commitmentOf } from '../src/commit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '..');
const ROOT = path.resolve(SERVICE, '../..');
const CONTRACTS = path.join(ROOT, 'contracts');
const KIT = path.join(ROOT, 'seller-workspace/py-repair-kit');
const FOUNDRY_BIN = path.join(homedir(), '.foundry/bin');
const PORT = Number(process.env.ANVIL_PORT ?? 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const HARNESS_PORT = Number(process.env.HARNESS_PORT ?? 8547);
const WORK = process.env.INTEGRATION_DIR ?? mkdtempSync(path.join(tmpdir(), 'juror-integration-'));
const KILL_JUROR = Number(process.env.INTEGRATION_KILL_JUROR ?? 2);
const TIMEOUT_MS = Number(process.env.INTEGRATION_TIMEOUT_MS ?? 25 * 60_000);
const TASK_IDS = ['T1', 'T2', 'T3', 'T4', 'T5'];
const DISPUTED_CLAIM = 'C10';
const TASK_MASK = 0b10n; // T2

mkdirSync(WORK, { recursive: true });
const logFile = createWriteStream(path.join(WORK, 'integration.log'));
function log(line: string) {
  const l = `[integration ${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(l);
  logFile.write(`${l}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ChildProcess[] = [];
let harness: Server | null = null;

function cleanup() {
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
  harness?.close();
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ------------------------------------------------------------------ anvil + deploy

async function startAnvil() {
  const anvil = spawn(path.join(FOUNDRY_BIN, 'anvil'), ['--port', String(PORT), '--block-time', '1', '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  procs.push(anvil);
  const pc = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 50; i++) {
    try {
      const id = await pc.getChainId();
      if (id !== 31337) throw new Error(`refusing: chainId ${id} at ${RPC} is not local anvil`);
      return;
    } catch (e) {
      if ((e as Error).message.startsWith('refusing')) throw e;
      await sleep(200);
    }
  }
  throw new Error(`anvil did not start on ${RPC}`);
}

function deploy(env: Record<string, string>) {
  const common = { ...process.env, ...env, PATH: `${FOUNDRY_BIN}:${process.env.PATH}` };
  const out = execFileSync('forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC, '--broadcast'], { cwd: CONTRACTS, env: common, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(path.join(WORK, 'forge-deploy.log'), out);
  const depFile = path.join(WORK, 'deployments/31337.json');
  execFileSync('node', [path.join(CONTRACTS, 'scripts/write-deployment.mjs'), path.join(CONTRACTS, 'broadcast/Deploy.s.sol/31337/run-latest.json'), RPC, depFile], { env: common, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(readFileSync(depFile, 'utf8')) as { market: Address; token: Address; startBlock: number; params: Record<string, number> };
}

// ------------------------------------------------------------------ evidence (real product facts)

function hiddenTestCounts(): { method: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let method = 'python -m pytest --collect-only -q (PYTHONPATH=src) on each purchased task hidden tests';
  for (const t of TASK_IDS) {
    try {
      const out = execFileSync('python3', ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider', `tasks/${t}/tests`], {
        cwd: KIT,
        env: { ...process.env, PYTHONPATH: 'src' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const m = /(\d+) tests? collected/.exec(out);
      if (!m) throw new Error('no count');
      counts[t] = Number(m[1]);
    } catch {
      method = 'static count of top-level test functions in each purchased task hidden test files (pytest unavailable)';
      const dir = path.join(KIT, 'tasks', t, 'tests');
      counts[t] = readdirSync(dir)
        .filter((f) => f.startsWith('test_') && f.endsWith('.py'))
        .reduce((n, f) => n + (readFileSync(path.join(dir, f), 'utf8').match(/^def test_\w+/gm)?.length ?? 0), 0);
    }
  }
  return { method, counts };
}

function startHarness(a: { market: Address; chainId: number; pc: Clients['publicClient']; packetFor: (id: bigint) => unknown }): Promise<string> {
  const blobs = path.join(WORK, 'harness-blobs');
  mkdirSync(blobs, { recursive: true });
  const abi = loadAbi('EnvMarket');
  harness = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = req.url ?? '';
      if (req.method === 'PUT' && url === '/blobs') {
        const sha = sha256Hex(new Uint8Array(body));
        writeFileSync(path.join(blobs, sha), body);
        return send(200, { sha256: sha });
      }
      const m = /^\/evidence\/(\d+)$/.exec(url);
      if (req.method === 'POST' && m) {
        const id = BigInt(m[1]!);
        const { juror, message, signature } = JSON.parse(body.toString('utf8')) as { juror: Address; message: string; signature: Hex };
        if (!(await verifyEvidenceAuth({ message, signature, juror }))) return send(401, { error: 'bad signature or expired' });
        if (!message.includes(`\ndisputeId: ${id}\n`) || !message.includes(`\nmarket: ${a.market.toLowerCase()}\n`) || !message.includes(`chainId: ${a.chainId}\n`)) {
          return send(401, { error: 'challenge does not bind this dispute/market/chain' });
        }
        const [d, seats] = (await a.pc.readContract({ address: a.market, abi, functionName: 'getDispute', args: [id] })) as [{ round: number; status: number }, Array<{ juror: Address }>];
        const base = (Number(d.round) - 1) * 3;
        const seated = seats.slice(base, base + 3).some((s) => s.juror.toLowerCase() === juror.toLowerCase());
        if (Number(d.status) !== 2 || !seated) return send(403, { error: 'not a seated juror of the current round' });
        log(`harness: served case packet for dispute ${id} to ${juror}`);
        return send(200, a.packetFor(id));
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
  return new Promise((resolve) => harness!.listen(HARNESS_PORT, '127.0.0.1', () => resolve(`http://127.0.0.1:${HARNESS_PORT}`)));
}

// ------------------------------------------------------------------ main

async function main() {
  log(`work dir ${WORK}`);
  process.env.RPC_URL = RPC;
  process.env.CHAIN_ID = '31337';
  process.env.DEPLOYMENTS_DIR = path.join(WORK, 'deployments');
  delete process.env.MARKET_ADDRESS;
  delete process.env.TOKEN_ADDRESS;
  delete process.env.START_BLOCK;
  const base = loadEnv({ chainId: 31337 });
  const addrs = base.roleAddresses;
  for (const r of ['deployer', 'seller', 'buyer', 'runner', 'relay', 'juror1', 'juror2', 'juror3'] as const) {
    if (!base.keys[r]) throw new Error(`missing ${r.toUpperCase()}_PK in .env`);
  }
  if (!base.encKeys.buyer) throw new Error('missing BUYER_ENC_SK/BUYER_ENC_PK in .env');

  await startAnvil();
  log(`anvil up at ${RPC}`);
  const pc0 = createPublicClient({ transport: http(RPC) });
  for (const a of Object.values(addrs)) await pc0.request({ method: 'anvil_setBalance' as never, params: [a, '0x56BC75E2D63100000'] as never });

  const dep = deploy({
    DEPLOYER_PK: base.keys.deployer!,
    TOKEN_ADDR: '',
    PARAM_SET: 'demo',
    SELLER_ADDR: addrs.seller!,
    BUYER_ADDR: addrs.buyer!,
    BUYER2_ADDR: addrs.buyer2 ?? '',
    RUNNER_ADDR: addrs.runner!,
    RELAY_ADDR: addrs.relay!,
    VERIFIER_ADDR: addrs.verifier ?? addrs.runner!,
    JUROR1_ADDR: addrs.juror1!,
    JUROR2_ADDR: addrs.juror2!,
    JUROR3_ADDR: addrs.juror3!,
  });
  log(`deployed market ${dep.market} token ${dep.token} startBlock ${dep.startBlock} (demo params: jurorStake ${dep.params.jurorStake / 1e6}, caseFee ${dep.params.caseFee / 1e6})`);

  const cfg = loadEnv({ chainId: 31337, requireDeployment: true });
  const C = (role: 'seller' | 'buyer' | 'runner' | 'relay' | 'deployer') => makeClients(role, { config: cfg });
  const seller = C('seller');
  const buyer = C('buyer');
  const relay = C('relay');
  const runnerAcct = privateKeyToAccount(cfg.keys.runner!);
  const pc = seller.publicClient;
  const market = dep.market;
  const MA = loadAbi('EnvMarket');
  const TA = loadAbi('TestUSDC');
  const read = <T>(functionName: string, args: readonly unknown[] = [], address: Address = market, abi = MA) =>
    pc.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const write = (cl: Clients, functionName: string, args: readonly unknown[], label = functionName) =>
    writeAndWait(cl, { address: market, abi: MA, functionName, args, label }, { log: (l) => log(l) });
  const bal = (a: Address) => read<bigint>('balanceOf', [a], dep.token, TA);
  const domain = envMarketDomain(31337, market);

  // ---- evidence source
  const descBytes = readFileSync(path.join(KIT, 'listing/description.json'));
  const description = JSON.parse(descBytes.toString('utf8')) as { environmentVersion: string; claims: Array<{ id: string }> };
  const descriptionHash = sha256Hex(new Uint8Array(descBytes));
  const findings = hiddenTestCounts();
  log(`hidden test counts (${findings.method}): ${JSON.stringify(findings.counts)}`);
  const buyerEvidence = {
    type: 'envmarket.buyer-evidence.v1',
    disputedClaims: [DISPUTED_CLAIM],
    disputedTasks: ['T2'],
    statement:
      'Claim C10 says every purchased task has at least 8 hidden test cases as collected by pytest. After decrypting the delivered bundle and running pytest collection on each hidden suite, task T2 collects only 5 test cases.',
  };
  const evidenceHash = sha256Hex(canonicalJson(buyerEvidence));

  let teeUrl = process.env.TEE_URL?.replace(/\/+$/, '');
  let evidenceSource = 'services/tee';
  if (teeUrl) {
    try {
      await fetch(`${teeUrl}/health`, { signal: AbortSignal.timeout(3000) });
    } catch {
      log(`TEE_URL ${teeUrl} unreachable; using the test harness evidence server`);
      teeUrl = undefined;
    }
  }

  // ---- listing
  const tar = canonicalTarOfDir(path.join(KIT, 'tasks'));
  const kBundle = randomKey();
  const ct = encryptFile(kBundle, tar);
  const bundleHash = sha256Hex(tar);
  const ciphertextHash = sha256Hex(ct);
  const tree = buildTaskTree({
    environmentVersion: description.environmentVersion,
    graderDigest: graderDigestOfDir(path.join(KIT, 'grader')),
    tasks: TASK_IDS.map((taskId) => ({ taskId, taskHash: taskHashOfDir(path.join(KIT, 'tasks', taskId)), salt: randomSalt() })),
  });
  const digestMatch = /@sha256:([0-9a-f]{64})/.exec(readFileSync(path.join(KIT, 'IMAGE_DIGEST'), 'utf8'));
  if (!digestMatch) throw new Error('IMAGE_DIGEST: no @sha256:<64 hex> image reference');
  const imageDigest = `0x${digestMatch[1]}` as Hex;
  const price = 100_000_000n;
  const collateral = 100_000_000n;
  await ensureAllowance(seller, market, collateral, { tokenAddress: dep.token });
  await write(seller, 'depositCollateral', [collateral]);
  const vin = {
    bundleHash,
    ciphertextHash,
    imageDigest,
    descriptionHash,
    manifestHash: sha256Hex(new Uint8Array(readFileSync(path.join(KIT, 'listing/manifest.template.json')))),
    licenseHash: sha256Hex(new Uint8Array(readFileSync(path.join(KIT, 'LICENSE-ENV.md')))),
    taskRoot: tree.root,
    auditRoot: `0x${'00'.repeat(32)}` as Hex,
    taskCount: 5,
    auditTaskCount: 2,
    price,
    collateral,
    deliveryWindow: 0,
    challengeWindow: 0,
    uri: teeUrl ? `${teeUrl}/blobs/` : `http://127.0.0.1:${HARNESS_PORT}/blobs/`,
  };
  const created = await write(seller, 'createListing', [vin]);
  const versionId = created.result as bigint;
  const report = {
    type: 'envmarket.integration-test-report',
    note: 'Juror integration-test fixture: no preview was run; attached only so the listing is purchasable on local anvil.',
    versionId: versionId.toString(),
    bundleHash,
    attestation: { kind: 'none-local-dev' },
  };
  const reportHash = sha256Hex(canonicalJson(report));
  const reportSig = await signPreviewReport(runnerAcct, domain, { versionId, bundleHash, reportHash });
  await write(seller, 'attachReport', [versionId, reportHash, reportSig]);

  // ---- purchase + delivery
  await ensureAllowance(buyer, market, price, { tokenAddress: dep.token });
  const bought = await write(buyer, 'buy', [versionId, base.encKeys.buyer!.publicKey, price]);
  const purchaseId = bought.result as bigint;
  const w = buildDeliveryWrapper({
    purchaseId,
    chainId: 31337,
    market,
    buyer: buyer.account.address,
    buyerEncPubKey: base.encKeys.buyer!.publicKey,
    versionId,
    bundleHash,
    ciphertextHash,
    relay: relay.account.address,
  });
  const wrapped = wrapKey({ key: kBundle, recipientPublicKey: base.encKeys.buyer!.publicKey, wrapperHash: w.wrapperHash });
  const wrappedKeyHash = sha256Hex(wrapped);
  const relaySig = await signDeliveryReceipt(relay.account, domain, {
    purchaseId,
    buyerEncPubKey: base.encKeys.buyer!.publicKey,
    ciphertextHash,
    wrappedKeyHash,
    wrapperHash: w.wrapperHash,
  });
  await write(relay, 'recordDelivery', [purchaseId, ciphertextHash, wrappedKeyHash, w.wrapperHash, relaySig]);

  // ---- evidence server (harness unless a real TEE was given)
  if (!teeUrl) {
    evidenceSource = 'integration-test harness';
    teeUrl = await startHarness({
      market,
      chainId: 31337,
      pc,
      packetFor: (id) => ({
        type: 'envmarket.case-packet.v1',
        source:
          'INTEGRATION TEST HARNESS standing in for the services/tee POST /evidence route. Facts below are computed from the real seller files of this listing.',
        disputeId: id.toString(),
        purchaseId: purchaseId.toString(),
        ground: 'FalseDescription',
        disputedTasks: ['T2'],
        disputedClaims: [DISPUTED_CLAIM],
        frozenDescription: { descriptionHash, claims: description.claims },
        buyerStatement: buyerEvidence.statement,
        buyerEvidenceHash: evidenceHash,
        mechanicalFindings: {
          producedBy: 'integration harness on the delivered task files',
          method: findings.method,
          hiddenTestCaseCountsPerPurchasedTask: findings.counts,
        },
        sellerResponse: null,
      }),
    });
  }
  log(`evidence source: ${evidenceSource} at ${teeUrl}`);

  // ---- jurors: register via the real CLI, then run all three
  const jurorEnv = {
    ...process.env,
    RPC_URL: RPC,
    CHAIN_ID: '31337',
    DEPLOYMENTS_DIR: path.join(WORK, 'deployments'),
    // explicit: process env beats any MARKET_ADDRESS / TOKEN_ADDR (e.g. Base USDC) in the repo .env
    MARKET_ADDRESS: market,
    TOKEN_ADDR: dep.token,
    START_BLOCK: String(dep.startBlock),
    TEE_URL: teeUrl,
    JUROR_DATA_DIR: path.join(WORK, 'data'),
    JUROR_POLL_MS: '1000',
    NO_COLOR: '1',
  };
  // async (not execFileSync): the harness blob store runs in this process and must stay responsive
  for (const n of [1, 2, 3]) {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(SERVICE, 'src/juror.ts'), 'register'], {
      cwd: SERVICE,
      env: { ...jurorEnv, JUROR_INDEX: String(n) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    for (const l of out.trim().split('\n')) log(l);
    if (code !== 0) throw new Error(`juror${n} register exited ${code}`);
  }
  const jurors = [cfg.roleAddresses.juror1!, cfg.roleAddresses.juror2!, cfg.roleAddresses.juror3!];
  const jurorBalBefore = await Promise.all(jurors.map(bal));
  const jurorLog = createWriteStream(path.join(WORK, 'jurors.log'));
  const runAll = spawn(process.execPath, ['--import', 'tsx', path.join(SERVICE, 'src/run-all.ts')], { cwd: SERVICE, env: jurorEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(runAll);
  for (const s of [runAll.stdout!, runAll.stderr!]) {
    s.on('data', (b: Buffer) => {
      process.stdout.write(b);
      jurorLog.write(b);
    });
  }
  await sleep(3000);

  // ---- open the seeded FalseDescription dispute
  const [, bond] = await read<[bigint, bigint]>('quoteDispute', [purchaseId, TASK_MASK]);
  await ensureAllowance(buyer, market, bond, { tokenAddress: dep.token });
  const opened = await write(buyer, 'openDispute', [purchaseId, 2, TASK_MASK, evidenceHash]);
  const disputeId = opened.result as bigint;
  log(`opened FalseDescription dispute #${disputeId} on purchase ${purchaseId} (claim ${DISPUTED_CLAIM}, taskMask 0x2, bond ${formatUnits(bond, 6)})`);

  // ---- restart-safety: kill one juror right after its commit is confirmed
  const stateFile = (n: number) => path.join(WORK, 'data', `juror${n}.json`);
  const roundRec = (n: number, round = 1) => {
    try {
      const s = JSON.parse(readFileSync(stateFile(n), 'utf8'));
      return Object.values(s.deployments as Record<string, { disputes: Record<string, { rounds: Record<string, Record<string, unknown>> }> }>)[0]?.disputes[disputeId.toString()]?.rounds[String(round)];
    } catch {
      return undefined;
    }
  };
  let killed = false;
  const t0 = Date.now();
  let d: { status: number; verdict: number; refund: bigint; fallbackNoQuorum: boolean; round: number } | undefined;
  let seats: Array<{ juror: Address; vote: number; revealed: boolean; commitment: Hex; reward: bigint; slashed: bigint }> = [];
  while (Date.now() - t0 < TIMEOUT_MS) {
    if (KILL_JUROR && !killed && roundRec(KILL_JUROR)?.commitConfirmed) {
      const lock = path.join(WORK, 'data', `juror${KILL_JUROR}.lock`);
      const pid = Number(readFileSync(lock, 'utf8'));
      process.kill(pid, 'SIGKILL');
      killed = true;
      log(`RESTART TEST: SIGKILLed juror${KILL_JUROR} (pid ${pid}) right after its commit; run-all must restart it and it must reveal from the persisted salt`);
    }
    [d, seats] = await read<[typeof d & object, typeof seats]>('getDispute', [disputeId]);
    if (Number(d!.status) === 3) break;
    await sleep(2000);
  }
  if (!d || Number(d.status) !== 3) throw new Error('dispute did not resolve before timeout');
  const verdict = d.fallbackNoQuorum ? 'FallbackNoQuorum' : Number(d.verdict) === 1 ? 'Uphold' : 'Reject';
  log(`dispute #${disputeId} RESOLVED on-chain: ${verdict}, refund ${formatUnits(d.refund, 6)}, rounds used ${d.round}`);

  // wait for juror withdrawals
  for (let i = 0; i < 60; i++) {
    const cl = await Promise.all(jurors.map((j) => read<bigint>('claimable', [j])));
    if (cl.every((x) => x === 0n)) break;
    await sleep(1000);
  }

  // ---- checks
  const checks: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, detail = '') => {
    checks.push([name, ok, detail]);
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const purchase = await read<{ state: number; refunded: bigint; sellerProceeds: bigint; fee: bigint; penalties: bigint }>('getPurchase', [purchaseId]);
  check('purchase settled exactly once', Number(purchase.state) === 5, `state ${purchase.state}`);
  const round = Number(d.round);
  const panel = seats.slice((round - 1) * 3, round * 3);
  const buyerClaimable = await read<bigint>('claimable', [buyer.account.address]);
  if (verdict === 'Uphold') {
    check('refund = price / taskCount for the one disputed task', d.refund === price / 5n, formatUnits(d.refund, 6));
    check('buyer credited refund + full bond', buyerClaimable === d.refund + bond, formatUnits(buyerClaimable, 6));
    check('seller penalty applied (1 of 5 tasks > 5% threshold)', purchase.penalties === (price * 1000n) / 10000n, formatUnits(purchase.penalties, 6));
  } else if (verdict === 'Reject') {
    check('no refund on Reject', d.refund === 0n);
    log('WARNING: jurors rejected a claim the seller workspace documents as false (seeded dispute expects Uphold)');
  }
  check('verdict matches the seeded expectation (Uphold)', verdict === 'Uphold', verdict);

  for (let k = 0; k < 3; k++) {
    const s = panel[k]!;
    const n = jurors.findIndex((j) => j.toLowerCase() === s.juror.toLowerCase()) + 1;
    const rr = roundRec(n, round) as { salt?: Hex; verdict?: 'Uphold' | 'Reject'; rationalePublished?: { file: string; sha256: Hex; blobUrl?: string } } | undefined;
    check(`juror${n} revealed`, s.revealed, `vote ${s.vote === 1 ? 'Uphold' : s.vote === 2 ? 'Reject' : 'none'}, reward ${formatUnits(s.reward, 6)}, slashed ${formatUnits(s.slashed, 6)}`);
    if (rr?.salt && rr.verdict) {
      const sol = await read<Hex>('commitmentFor', [disputeId, round, rr.verdict === 'Uphold' ? 1 : 2, rr.salt, s.juror]);
      const ts = commitmentOf({ disputeId, round, verdict: rr.verdict, salt: rr.salt, juror: s.juror });
      check(`juror${n} commitment = Solidity commitmentFor = TS commitmentOf`, sol === s.commitment && ts === s.commitment);
    } else check(`juror${n} persisted secret present`, false);
    const pubOk = !!rr?.rationalePublished && existsSync(rr.rationalePublished.file);
    check(`juror${n} screened rationale published`, pubOk, rr?.rationalePublished ? `${rr.rationalePublished.sha256}${rr.rationalePublished.blobUrl ? ` ${rr.rationalePublished.blobUrl}` : ''}` : '');
    if (pubOk) {
      const doc = JSON.parse(readFileSync(rr!.rationalePublished!.file, 'utf8'));
      log(`  juror${n} [${doc.model.served}] ${doc.verdict} (conf ${doc.confidence}): ${doc.rationale}`);
    }
  }
  if (KILL_JUROR) check(`restart test: juror${KILL_JUROR} was killed after commit and still revealed`, killed && !!panel.find((s) => s.juror.toLowerCase() === jurors[KILL_JUROR - 1]!.toLowerCase())?.revealed);

  const jurorBalAfter = await Promise.all(jurors.map(bal));
  for (let i = 0; i < 3; i++) {
    const s = seats.find((x) => x.juror.toLowerCase() === jurors[i]!.toLowerCase());
    const gained = jurorBalAfter[i]! - jurorBalBefore[i]!;
    check(`juror${i + 1} withdrew its reward (pull payment)`, s ? gained === s.reward : true, `+${formatUnits(gained, 6)}`);
  }

  const parts = await Promise.all(['totalEscrow', 'totalCollateral', 'totalBonds', 'totalJurorStake', 'treasury', 'reserve', 'totalClaimable'].map((f) => read<bigint>(f)));
  const held = await bal(market);
  check('accounting invariant: token balance == sum of buckets', held === parts.reduce((a, b) => a + b, 0n), `${formatUnits(held, 6)} held`);

  const failed = checks.filter((c) => !c[1]);
  writeFileSync(
    path.join(WORK, 'summary.json'),
    JSON.stringify({ market, disputeId: disputeId.toString(), verdict, evidenceSource, checks: checks.map(([n, ok, det]) => ({ n, ok, det })) }, null, 2),
  );
  log(`${checks.length - failed.length}/${checks.length} checks passed; logs + summary in ${WORK}`);
  return failed.length === 0;
}

main()
  .then(async (ok) => {
    cleanup();
    await sleep(1500);
    process.exit(ok ? 0 : 1);
  })
  .catch(async (e) => {
    log(`FATAL ${(e as Error).stack ?? e}`);
    cleanup();
    await sleep(1500);
    process.exit(1);
  });

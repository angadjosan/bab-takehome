/**
 * Explicit funding step for real networks (never run automatically by e2e).
 *
 *   tsx demo/fund.ts            # print the plan: current balances, targets, shortfalls
 *   tsx demo/fund.ts --yes      # send the shortfalls from DEPLOYER (token + gas ETH)
 *
 * Targets (token units; env overrides FUND_SELLER, FUND_BUYER, FUND_BUYER2, FUND_JUROR, FUND_ETH):
 *   seller 1.0 · buyer 0.7 · buyer2 0.6 · juror1..3 0.3 each · gas ETH 0.00003 each
 * Only shortfalls are sent (target - current balance). TEE_SIGNER_ADDR (the EigenCompute app
 * wallet) is topped up with gas ETH only, if set. On anvil (31337) the token shortfall is minted
 * with TestUSDC.mint by the deployer (owner) instead of transferred.
 */
import { erc20Abi, formatEther, formatUnits, getAddress, parseEther, parseUnits, type Abi, type Address } from 'viem';
import { loadAbi } from '@envmarket/shared';
import { ANVIL, TX_LOG, assertTxAllowed, explorerTx, loadCtx, send, signer, tokenInfo } from '../src/common/ctx.ts';

const yes = process.argv.includes('--yes');
const ctx = loadCtx();
const t = await tokenInfo(ctx);
const env = ctx.cfg.env;
const tok = (k: string, d: string) => parseUnits(env[k] ?? d, t.decimals);
const ethTarget = parseEther(env.FUND_ETH ?? '0.00003');

const plan: Array<{ role: string; address: Address; token: bigint; eth: bigint }> = [
  { role: 'seller', address: ctx.cfg.roleAddresses.seller!, token: tok('FUND_SELLER', '1.0'), eth: ethTarget },
  { role: 'buyer', address: ctx.cfg.roleAddresses.buyer!, token: tok('FUND_BUYER', '0.7'), eth: ethTarget },
  { role: 'buyer2', address: ctx.cfg.roleAddresses.buyer2!, token: tok('FUND_BUYER2', '0.6'), eth: ethTarget },
  { role: 'juror1', address: ctx.cfg.roleAddresses.juror1!, token: tok('FUND_JUROR', '0.3'), eth: ethTarget },
  { role: 'juror2', address: ctx.cfg.roleAddresses.juror2!, token: tok('FUND_JUROR', '0.3'), eth: ethTarget },
  { role: 'juror3', address: ctx.cfg.roleAddresses.juror3!, token: tok('FUND_JUROR', '0.3'), eth: ethTarget },
];
if (env.TEE_SIGNER_ADDR) plan.push({ role: 'tee-signer', address: getAddress(env.TEE_SIGNER_ADDR), token: 0n, eth: ethTarget });
for (const p of plan) if (!p.address) throw new Error(`missing address for ${p.role}`);

const deployer = signer(ctx, 'deployer');
const pc = ctx.read.publicClient;
const bal = (a: Address) => pc.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

console.log(`chain ${ctx.chainId} · token ${t.symbol} ${ctx.token} · deployer ${deployer.account.address}`);
const dTok = await bal(deployer.account.address);
const dEth = await pc.getBalance({ address: deployer.account.address });
console.log(`deployer balance: ${formatUnits(dTok, t.decimals)} ${t.symbol}, ${formatEther(dEth)} ETH\n`);
console.log(`${'role'.padEnd(11)} ${'address'.padEnd(42)} ${'token have → target'.padEnd(26)} ${'send'.padEnd(10)} ${'ETH have → target'.padEnd(30)} send`);
let needTok = 0n;
let needEth = 0n;
const rows: Array<{ role: string; address: Address; sendTok: bigint; sendEth: bigint }> = [];
for (const p of plan) {
  const hT = await bal(p.address);
  const hE = await pc.getBalance({ address: p.address });
  const sT = p.token > hT ? p.token - hT : 0n;
  const sE = p.eth > hE ? p.eth - hE : 0n;
  needTok += sT;
  needEth += sE;
  rows.push({ role: p.role, address: p.address, sendTok: sT, sendEth: sE });
  console.log(
    `${p.role.padEnd(11)} ${p.address} ${`${formatUnits(hT, t.decimals)} → ${formatUnits(p.token, t.decimals)}`.padEnd(26)} ${formatUnits(sT, t.decimals).padEnd(10)} ${`${formatEther(hE)} → ${formatEther(p.eth)}`.padEnd(30)} ${formatEther(sE)}`,
  );
}
console.log(`\ntotal to send: ${formatUnits(needTok, t.decimals)} ${t.symbol} + ${formatEther(needEth)} ETH (plus gas)`);
const mintable = ctx.chainId === ANVIL;
if (!mintable && dTok < needTok) console.log(`MISSING: deployer needs ${formatUnits(needTok - dTok, t.decimals)} more ${t.symbol}`);
if (dEth < needEth) console.log(`MISSING: deployer needs ${formatEther(needEth - dEth)} more ETH (+ gas)`);
if (!yes) {
  console.log('\nplan only — nothing sent. Re-run with --yes to send the shortfalls from DEPLOYER.');
  process.exit(0);
}
process.env.ALLOW_LIVE_TX = '1'; // --yes is the explicit consent for this funding run
assertTxAllowed(ctx.chainId);
for (const r of rows) {
  if (r.sendTok > 0n) {
    if (mintable) await send(deployer, { address: ctx.token, abi: loadAbi('TestUSDC'), functionName: 'mint', args: [r.address, r.sendTok], label: `fund.mint(${r.role})` });
    else await send(deployer, { address: ctx.token, abi: erc20Abi as Abi, functionName: 'transfer', args: [r.address, r.sendTok], label: `fund.transfer(${r.role})` });
  }
  if (r.sendEth > 0n) {
    const hash = await deployer.walletClient.sendTransaction({ to: r.address, value: r.sendEth });
    const rc = await pc.waitForTransactionReceipt({ hash });
    const url = explorerTx(ctx.chainId, hash);
    console.log(`  ⛓  fund.eth(${r.role}) ${url ?? hash} [${rc.status}]`);
    TX_LOG.push({ label: `fund.eth(${r.role})`, from: deployer.account.address, hash, url, block: rc.blockNumber, gasUsed: rc.gasUsed });
  }
}
console.log(`done: ${TX_LOG.length} transaction(s)`);

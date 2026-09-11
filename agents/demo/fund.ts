/**
 * Explicit funding step (never run automatically by e2e).
 *
 *   tsx demo/fund.ts            # print the plan: current balances, targets, shortfalls, how each is covered
 *   tsx demo/fund.ts --yes      # send it
 *
 * Deployment target is Base Sepolia (84532) with TestUSDC (6 decimals, public 24h-rate-limited faucet()).
 * Per actor, in this order:
 *   1. gas ETH shortfall: sent from DEPLOYER (anvil: anvil_setBalance)
 *   2. token shortfall:   TestUSDC.mint by DEPLOYER if it owns the token; else the actor calls faucet()
 *                         itself when available (faucetAvailableAt); else transfer from DEPLOYER
 * Targets (token units; env FUND_SELLER, FUND_BUYER, FUND_BUYER2, FUND_JUROR, FUND_ETH):
 *   TestUSDC (demo params): seller 500 · buyer 200 · buyer2 250 · juror1..3 50 each · ETH 0.002 each (84532)
 *   real USDC:              seller 1.0 · buyer 0.7 · buyer2 0.6 · juror1..3 0.3 each · ETH 0.00003 each
 * TEE_SIGNER_ADDR (the EigenCompute app wallet) gets gas ETH only, if set.
 */
import { erc20Abi, formatEther, formatUnits, getAddress, parseEther, parseUnits, type Abi, type Address } from 'viem';
import { loadAbi } from '@envmarket/shared';
import { ANVIL, BASE_SEPOLIA, TX_LOG, assertTxAllowed, explorerTx, loadCtx, send, signer, tokenInfo } from '../src/common/ctx.ts';

const yes = process.argv.includes('--yes');
const ctx = loadCtx();
const t = await tokenInfo(ctx);
const env = ctx.cfg.env;
const pc = ctx.read.publicClient;
const testAbi = loadAbi('TestUSDC');

// Is this our TestUSDC (faucet + owner mint)?
let isTestToken = false;
let tokenOwner: Address | null = null;
try {
  await pc.readContract({ address: ctx.token, abi: testAbi, functionName: 'FAUCET_AMOUNT' });
  isTestToken = true;
  tokenOwner = getAddress((await pc.readContract({ address: ctx.token, abi: testAbi, functionName: 'owner' })) as string);
} catch {
  /* real USDC or another ERC-20 */
}

const tok = (k: string, test: string, real: string) => parseUnits(env[k] ?? (isTestToken ? test : real), t.decimals);
const ethTarget = parseEther(env.FUND_ETH ?? (ctx.chainId === BASE_SEPOLIA ? '0.002' : ctx.chainId === ANVIL ? '10' : '0.00003'));
type Role = 'seller' | 'buyer' | 'buyer2' | 'juror1' | 'juror2' | 'juror3';
const plan: Array<{ role: Role | 'tee-signer'; address: Address; token: bigint; eth: bigint }> = [
  { role: 'seller', address: ctx.cfg.roleAddresses.seller!, token: tok('FUND_SELLER', '500', '1.0'), eth: ethTarget },
  { role: 'buyer', address: ctx.cfg.roleAddresses.buyer!, token: tok('FUND_BUYER', '200', '0.7'), eth: ethTarget },
  { role: 'buyer2', address: ctx.cfg.roleAddresses.buyer2!, token: tok('FUND_BUYER2', '250', '0.6'), eth: ethTarget },
  { role: 'juror1', address: ctx.cfg.roleAddresses.juror1!, token: tok('FUND_JUROR', '50', '0.3'), eth: ethTarget },
  { role: 'juror2', address: ctx.cfg.roleAddresses.juror2!, token: tok('FUND_JUROR', '50', '0.3'), eth: ethTarget },
  { role: 'juror3', address: ctx.cfg.roleAddresses.juror3!, token: tok('FUND_JUROR', '50', '0.3'), eth: ethTarget },
];
if (env.TEE_SIGNER_ADDR) plan.push({ role: 'tee-signer', address: getAddress(env.TEE_SIGNER_ADDR), token: 0n, eth: ethTarget });
for (const p of plan) if (!p.address) throw new Error(`missing address for ${p.role}`);

const deployer = signer(ctx, 'deployer');
const canMint = isTestToken && tokenOwner !== null && tokenOwner.toLowerCase() === deployer.account.address.toLowerCase();
const bal = (a: Address) => pc.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const now = BigInt(Math.floor(Date.now() / 1000));
const faucetAmount = isTestToken ? ((await pc.readContract({ address: ctx.token, abi: testAbi, functionName: 'FAUCET_AMOUNT' })) as bigint) : 0n;

console.log(`chain ${ctx.chainId} · token ${t.symbol} ${ctx.token}${isTestToken ? ` (TestUSDC; owner ${tokenOwner}; faucet ${formatUnits(faucetAmount, t.decimals)}/24h)` : ''} · deployer ${deployer.account.address}`);
const dTok = await bal(deployer.account.address);
const dEth = await pc.getBalance({ address: deployer.account.address });
console.log(`deployer balance: ${formatUnits(dTok, t.decimals)} ${t.symbol}, ${formatEther(dEth)} ETH\n`);
console.log(`${'role'.padEnd(11)} ${'address'.padEnd(42)} ${'token have → target'.padEnd(24)} ${'ETH have → target'.padEnd(28)} cover`);

type Row = { role: string; address: Address; sendTok: bigint; sendEth: bigint; how: 'mint' | 'faucet' | 'transfer' | 'none' };
const rows: Row[] = [];
let needTransfer = 0n;
let needEth = 0n;
for (const p of plan) {
  const hT = await bal(p.address);
  const hE = await pc.getBalance({ address: p.address });
  const sT = p.token > hT ? p.token - hT : 0n;
  const sE = p.eth > hE ? p.eth - hE : 0n;
  let how: Row['how'] = 'none';
  if (sT > 0n) {
    if (canMint) how = 'mint';
    else if (isTestToken && p.role !== 'tee-signer' && ctx.cfg.keys[p.role as Role] && sT <= faucetAmount) {
      const at = (await pc.readContract({ address: ctx.token, abi: testAbi, functionName: 'faucetAvailableAt', args: [p.address] })) as bigint;
      how = at <= now ? 'faucet' : 'transfer';
    } else how = 'transfer';
  }
  if (how === 'transfer') needTransfer += sT;
  needEth += sE;
  rows.push({ role: p.role, address: p.address, sendTok: sT, sendEth: sE, how });
  console.log(
    `${p.role.padEnd(11)} ${p.address} ${`${formatUnits(hT, t.decimals)} → ${formatUnits(p.token, t.decimals)}`.padEnd(24)} ${`${formatEther(hE)} → ${formatEther(p.eth)}`.padEnd(28)} ${sT > 0n ? `${how} ${formatUnits(sT, t.decimals)}` : '-'}${sE > 0n ? ` + ${formatEther(sE)} ETH` : ''}`,
  );
}
console.log(`\ntotal from DEPLOYER: ${formatUnits(needTransfer, t.decimals)} ${t.symbol} transferred + ${formatEther(needEth)} ETH (plus gas)`);
if (dTok < needTransfer) console.log(`MISSING: deployer needs ${formatUnits(needTransfer - dTok, t.decimals)} more ${t.symbol}`);
if (ctx.chainId !== ANVIL && dEth < needEth) console.log(`MISSING: deployer needs ${formatEther(needEth - dEth)} more ETH (+ gas)`);
if (!yes) {
  console.log('\nplan only — nothing sent. Re-run with --yes to execute it.');
  process.exit(0);
}
if (!([ANVIL, BASE_SEPOLIA] as number[]).includes(ctx.chainId)) process.env.ALLOW_LIVE_TX = '1'; // --yes is the explicit consent off the default chains
assertTxAllowed(ctx.chainId);

// Nonce safety: the public (load-balanced) RPC can report a stale pending nonce between back-to-back
// sends from the DEPLOYER, so its nonce is read once and assigned explicitly; every tx also waits
// for its receipt before the next one. Anvil keeps viem's automatic nonces.
let deployerNonce: number | undefined =
  ctx.chainId === ANVIL ? undefined : await pc.getTransactionCount({ address: deployer.account.address, blockTag: 'pending' });
const nextNonce = (): number | undefined => (deployerNonce === undefined ? undefined : deployerNonce++);

for (const r of rows) {
  if (r.sendEth > 0n) {
    if (ctx.chainId === ANVIL) {
      await pc.request({ method: 'anvil_setBalance' as never, params: [r.address, `0x${(r.sendEth + (await pc.getBalance({ address: r.address }))).toString(16)}`] as never });
      console.log(`  ⛽ anvil_setBalance(${r.role})`);
    } else {
      const hash = await deployer.walletClient.sendTransaction({ to: r.address, value: r.sendEth, nonce: nextNonce() } as never);
      const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
      const url = explorerTx(ctx.chainId, hash);
      console.log(`  ⛓  fund.eth(${r.role}) ${url ?? hash} [${rc.status}]`);
      TX_LOG.push({ label: `fund.eth(${r.role})`, from: deployer.account.address, hash, url, block: rc.blockNumber, gasUsed: rc.gasUsed });
      if (rc.status !== 'success') throw new Error(`fund.eth(${r.role}) reverted: ${hash}`);
    }
  }
  if (r.sendTok > 0n) {
    if (r.how === 'mint') await send(deployer, { address: ctx.token, abi: testAbi, functionName: 'mint', args: [r.address, r.sendTok], label: `fund.mint(${r.role})`, nonce: nextNonce() });
    else if (r.how === 'faucet') await send(signer(ctx, r.role as Role), { address: ctx.token, abi: testAbi, functionName: 'faucet', args: [], label: `${r.role}.faucet()` });
    else if (r.how === 'transfer') await send(deployer, { address: ctx.token, abi: erc20Abi as Abi, functionName: 'transfer', args: [r.address, r.sendTok], label: `fund.transfer(${r.role})`, nonce: nextNonce() });
  }
}
console.log(`done: ${TX_LOG.length} transaction(s)`);

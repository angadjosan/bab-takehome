#!/usr/bin/env -S npx tsx
/**
 * Buyer agent CLI. `--as buyer|buyer2` selects BUYER_PK/BUYER_ENC_* or BUYER2_*.
 *
 *   tsx src/buyer/cli.ts browse [--json]
 *   tsx src/buyer/cli.ts buy --version 1 --max-price 100 [--budget 250] [--as buyer]
 *   tsx src/buyer/cli.ts receive <purchaseId>
 *   tsx src/buyer/cli.ts inspect <purchaseId> [--no-llm]
 *   tsx src/buyer/cli.ts dispute <purchaseId> --ground FalseDescription --tasks T1,T3 --evidence file.json
 *   tsx src/buyer/cli.ts dispute <purchaseId> --auto
 *   tsx src/buyer/cli.ts rate <purchaseId> --stars 4 --comment "..."
 *   tsx src/buyer/cli.ts refund <purchaseId> | withdraw | status <purchaseId> | policy [--budget X]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { formatUnits, parseUnits } from 'viem';
import { Ground, PurchaseState, enumName } from '@envmarket/shared';
import { fmt, getDispute, getPurchase, loadCtx, marketRead, signer, tokenInfo } from '../common/ctx.ts';
import { policyFile, purchaseDir, readJson } from '../common/paths.ts';
import { browse, buy, manifestTaskIds, openDispute, parseGround, parseTaskMask, printComparison, rate, receive, refundUndelivered, withdraw, type Who } from './actions.ts';
import { disputePlan, inspectPurchase, type Findings } from './inspect.ts';
import { SpendingPolicy } from './policy.ts';

const who = (o: { as?: string }): Who => {
  const w = (o.as ?? 'buyer') as Who;
  if (w !== 'buyer' && w !== 'buyer2') throw new Error('--as must be buyer or buyer2');
  return w;
};

const program = new Command().name('buyer-agent').description('EnvMarket buyer agent');

program
  .command('browse')
  .option('--json', 'print JSON rows')
  .option('--all', 'include inactive versions')
  .action(async (o) => {
    const ctx = loadCtx();
    const rows = await browse(ctx, { includeInactive: !!o.all });
    if (o.json) console.log(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    else await printComparison(ctx, rows);
  });

program
  .command('buy')
  .requiredOption('--version <id>', 'versionId')
  .requiredOption('--max-price <amount>', 'max price in token units')
  .option('--budget <amount>', 'set the total spending budget (token units) before buying')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .action(async (o) => {
    const ctx = loadCtx();
    const t = await tokenInfo(ctx);
    const r = await buy(ctx, who(o), BigInt(o.version), parseUnits(o.maxPrice, t.decimals), { budget: o.budget ? parseUnits(o.budget, t.decimals) : undefined });
    console.log(`purchaseId=${r.purchaseId}`);
  });

program
  .command('receive <purchaseId>')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .option('--timeout <sec>', 'max seconds to wait for delivery')
  .action(async (id, o) => {
    await receive(loadCtx(), who(o), BigInt(id), { timeoutSec: o.timeout ? Number(o.timeout) : undefined });
  });

program
  .command('inspect <purchaseId>')
  .option('--no-llm', 'mechanical checks only')
  .action(async (id, o) => {
    const f = await inspectPurchase(loadCtx(), BigInt(id), { llm: o.llm });
    console.log(`contradicted claims: ${f.contradicted.join(', ') || 'none'}`);
  });

program
  .command('dispute <purchaseId>')
  .option('--ground <g>', 'BrokenOrHashMismatch | FalseDescription | PreviewNotReproducible')
  .option('--tasks <spec>', 'task ids (T1,T3) or a numeric mask')
  .option('--evidence <file>', 'evidence file (uploaded privately to the TEE; sha256 goes on-chain)')
  .option('--auto', 'derive ground/tasks/evidence from inspect findings')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .action(async (id, o) => {
    const ctx = loadCtx();
    const pid = BigInt(id);
    const ids = manifestTaskIds(pid);
    if (o.auto) {
      const f = readJson<Findings>(path.join(purchaseDir(pid), 'findings.json'));
      const plan = disputePlan(f);
      if (!plan) {
        console.log('no mechanically-backed contradicted claim: not disputing');
        return;
      }
      console.log(`auto: FalseDescription on claim ${plan.claim.claimId} for tasks ${plan.taskIds.join(',')}`);
      fs.writeFileSync(path.join(purchaseDir(pid), 'evidence.json'), plan.evidence);
      await openDispute(ctx, who(o), pid, Ground.FalseDescription, parseTaskMask(plan.taskIds.join(','), ids), plan.evidence);
      return;
    }
    if (!o.ground || !o.tasks || !o.evidence) throw new Error('--ground, --tasks and --evidence are required (or --auto)');
    await openDispute(ctx, who(o), pid, parseGround(o.ground), parseTaskMask(o.tasks, ids), new Uint8Array(fs.readFileSync(o.evidence)));
  });

program
  .command('rate <purchaseId>')
  .requiredOption('--stars <n>', '1-5')
  .option('--comment <text>', 'comment (sha256 recorded on-chain)', '')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .action(async (id, o) => {
    await rate(loadCtx(), who(o), BigInt(id), Number(o.stars), o.comment);
  });

program
  .command('refund <purchaseId>')
  .description('apply the pre-delivery timeout refund')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .action(async (id, o) => refundUndelivered(loadCtx(), who(o), BigInt(id)));

program
  .command('withdraw')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .action(async (o) => {
    const ctx = loadCtx();
    const n = await withdraw(ctx, who(o));
    console.log(n === 0n ? 'nothing to withdraw' : `withdrew ${await fmt(ctx, n)}`);
  });

program
  .command('status <purchaseId>')
  .action(async (id) => {
    const ctx = loadCtx();
    const p = await getPurchase(ctx, BigInt(id));
    console.log(`purchase #${id}: ${enumName(PurchaseState, p.state)} version ${p.versionId} price ${await fmt(ctx, p.price)} refunded ${await fmt(ctx, p.refunded)} sellerProceeds ${await fmt(ctx, p.sellerProceeds)} fee ${await fmt(ctx, p.fee)} rated=${p.rated}`);
    if (p.disputeId > 0n) {
      const { d, seats } = await getDispute(ctx, p.disputeId);
      console.log(`dispute #${p.disputeId}: ${enumName(Ground, d.ground)} status ${d.status} verdict ${d.verdict} round ${d.round} refund ${await fmt(ctx, d.refund)} jurors ${seats.filter((s) => s.juror !== '0x0000000000000000000000000000000000000000').map((s) => `${s.juror.slice(0, 8)}(${s.revealed ? s.vote : '-'})`).join(' ')}`);
    }
  });

program
  .command('policy')
  .option('--budget <amount>', 'set total budget (token units)')
  .option('--as <who>', 'buyer | buyer2', 'buyer')
  .action(async (o) => {
    const ctx = loadCtx();
    const t = await tokenInfo(ctx);
    const pol = new SpendingPolicy(policyFile(who(o)));
    if (o.budget) pol.setBudget(parseUnits(o.budget, t.decimals));
    const l = pol.load();
    console.log(l ? `budget ${formatUnits(BigInt(l.budget), t.decimals)} spent ${formatUnits(BigInt(l.spent), t.decimals)} (${l.entries.length} entries)` : 'no budget set');
    const me = signer(ctx, who(o)).account.address;
    console.log(`claimable: ${await fmt(ctx, await marketRead<bigint>(ctx, 'claimable', [me]))}`);
  });

program.parseAsync().catch((e) => {
  console.error(`[buyer] error: ${(e as Error).message}`);
  process.exit(1);
});

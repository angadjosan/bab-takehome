#!/usr/bin/env -S npx tsx
/**
 * Seller agent CLI.
 *
 *   tsx src/seller/cli.ts package [--workspace DIR] [--price 100] [--collateral 100] [--challenge-window S] [--delivery-window S] [--force]
 *   tsx src/seller/cli.ts upload   [--version <environmentVersion>]
 *   tsx src/seller/cli.ts list     [--version <environmentVersion>]
 *   tsx src/seller/cli.ts deposit-collateral --amount 100
 *   tsx src/seller/cli.ts preview  [--version <environmentVersion> | --version-id N]
 *   tsx src/seller/cli.ts keeper   [--once] [--interval 15]
 *   tsx src/seller/cli.ts status
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { parseUnits } from 'viem';
import { loadCtx, marketRead, sellerStake, signer, sleep, tokenInfo, fmt } from '../common/ctx.ts';
import { sellerVersionDir, sellerWorkspace } from '../common/paths.ts';
import { TeeClient } from '../common/tee.ts';
import { keeperTick, listVersion, previewAndAttach, readState, uploadVersion, depositCollateral } from './actions.ts';
import { packageEnvironment, parseDescriptionLoose } from './package.ts';

function workspaceVersion(ws: string): string {
  const f = [path.join(ws, 'listing', 'description.json'), path.join(ws, 'description.json')].find((p) => fs.existsSync(p));
  if (!f) throw new Error(`no description.json in ${ws}`);
  return parseDescriptionLoose(fs.readFileSync(f, 'utf8')).description.environmentVersion;
}

function versionDir(opt: { version?: string; workspace?: string }): string {
  const v = opt.version ?? workspaceVersion(path.resolve(opt.workspace ?? sellerWorkspace()));
  const dir = sellerVersionDir(v);
  if (!fs.existsSync(path.join(dir, 'listing-input.json'))) throw new Error(`${dir} has no listing-input.json (run \`package\` first)`);
  return dir;
}

const program = new Command().name('seller-agent').description('EnvMarket seller agent');

program
  .command('package')
  .description('build the canonical payload, commitments and ciphertexts into agents/.data/seller/<version>/')
  .option('--workspace <dir>', 'seller workspace', sellerWorkspace())
  .option('--price <amount>', 'price in token units (e.g. 100)')
  .option('--collateral <amount>', 'collateral per sale in token units')
  .option('--decimals <n>', 'token decimals', '6')
  .option('--currency <sym>', 'currency label in the manifest')
  .option('--challenge-window <sec>', 'challenge window (>= market minimum)')
  .option('--delivery-window <sec>', 'delivery window (<= market maximum)')
  .option('--force', 'rebuild an existing (unlisted!) version directory')
  .action((o) => {
    const ws = path.resolve(o.workspace);
    const dec = Number(o.decimals);
    const r = packageEnvironment({
      workspace: ws,
      outDir: sellerVersionDir(workspaceVersion(ws)),
      price: o.price ? parseUnits(o.price, dec) : undefined,
      collateral: o.collateral ? parseUnits(o.collateral, dec) : undefined,
      decimals: dec,
      currency: o.currency,
      challengeWindowSec: o.challengeWindow ? Number(o.challengeWindow) : undefined,
      deliveryWindowSec: o.deliveryWindow ? Number(o.deliveryWindow) : undefined,
      force: !!o.force,
    });
    const v = r.listing.versionInput;
    console.log(`[seller] packaged ${r.listing.environmentVersion} → ${r.outDir}`);
    console.log(`  tasks ${r.listing.taskIds.join(',')} (audit: ${r.listing.auditTaskIds.length}, separately encrypted)`);
    for (const k of ['bundleHash', 'ciphertextHash', 'manifestHash', 'descriptionHash', 'licenseHash', 'imageDigest', 'taskRoot', 'auditRoot'] as const) console.log(`  ${k.padEnd(16)} ${v[k]}`);
    console.log(`  price ${v.price} collateral ${v.collateral} (base units)`);
  });

program
  .command('upload')
  .option('--version <v>', 'environmentVersion (default: from the workspace description)')
  .action(async (o) => {
    await uploadVersion(versionDir(o), new TeeClient());
  });

program
  .command('list')
  .option('--version <v>')
  .option('--uri <url>', 'override the blob base URL recorded on-chain')
  .action(async (o) => {
    const r = await listVersion(loadCtx(), versionDir(o), { uri: o.uri });
    console.log(`versionId=${r.versionId}`);
  });

program
  .command('deposit-collateral')
  .requiredOption('--amount <amount>', 'token units')
  .action(async (o) => {
    const ctx = loadCtx();
    const t = await tokenInfo(ctx);
    await depositCollateral(ctx, parseUnits(o.amount, t.decimals));
  });

program
  .command('preview')
  .option('--version <v>')
  .option('--version-id <id>')
  .action(async (o) => {
    const ctx = loadCtx();
    let id = o.versionId ? BigInt(o.versionId) : undefined;
    let dir: string | undefined;
    if (!id) {
      dir = versionDir(o);
      const st = readState(dir);
      if (!st.versionId) throw new Error('not listed yet; run `list`');
      id = BigInt(st.versionId);
    }
    await previewAndAttach(ctx, id, new TeeClient(), dir);
  });

program
  .command('keeper')
  .option('--once', 'single pass')
  .option('--interval <sec>', 'poll interval', '15')
  .option('--no-withdraw', 'do not withdraw proceeds')
  .action(async (o) => {
    const ctx = loadCtx();
    for (;;) {
      const r = await keeperTick(ctx, { withdraw: o.withdraw });
      console.log(`[keeper] finalized [${r.finalized.join(',')}] refunded [${r.refunded.join(',')}] withdrew ${r.withdrawn}`);
      if (o.once) break;
      await sleep(Number(o.interval) * 1000);
    }
  });

program.command('status').action(async () => {
  const ctx = loadCtx();
  const me = signer(ctx, 'seller').account.address;
  const s = await sellerStake(ctx, me);
  const [q, eligible] = await marketRead<[bigint, boolean, bigint, bigint]>(ctx, 'sellerScore', [me]);
  const claim = await marketRead<bigint>(ctx, 'claimable', [me]);
  console.log(`seller ${me}`);
  console.log(`  ${eligible ? 'Eligible seller' : `New seller — ${q}/100 transactions`} · Seller stake: ${await fmt(ctx, s.total)} (reserved ${await fmt(ctx, s.reserved)}, available ${await fmt(ctx, s.available)})`);
  console.log(`  claimable proceeds: ${await fmt(ctx, claim)}`);
  const versions = await marketRead<bigint[]>(ctx, 'listVersionIdsBySeller', [me]);
  console.log(`  versions: ${versions.join(', ') || '(none)'}`);
});

program.parseAsync().catch((e) => {
  console.error(`[seller] error: ${(e as Error).message}`);
  process.exit(1);
});

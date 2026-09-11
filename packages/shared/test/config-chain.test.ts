import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEther } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_USDC, explorerTxUrl, loadEnv, makeClients, parseDotenv, roleKey, waitTx } from '../src/index.ts';
import { ANVIL, ANVIL_ADDR0, ANVIL_PK0, hasAnvil, tmp } from './helpers.ts';

const ISOLATE = ['CHAIN_ID', 'RPC_URL', 'BASE_RPC', 'MARKET_ADDRESS', 'TOKEN_ADDR', 'TOKEN_ADDRESS', 'DEPLOYMENTS_DIR', 'SELLER_PK', 'SELLER_ADDR'];

function withCleanEnv<T>(fn: () => T): T {
  const saved = Object.fromEntries(ISOLATE.map((k) => [k, process.env[k]]));
  for (const k of ISOLATE) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('config', () => {
  it('parseDotenv', () => {
    expect(parseDotenv('A=1\n# c\nexport B="x y"\nC=\'q\'\nD=v # comment\nE=\n')).toEqual({ A: '1', B: 'x y', C: 'q', D: 'v', E: '' });
  });

  it('defaults to Base mainnet with native USDC; reads deployments/<chainId>.json', () =>
    withCleanEnv(() => {
      const root = tmp();
      fs.writeFileSync(path.join(root, '.env'), `SELLER_PK=${ANVIL_PK0.slice(2)}\n`);
      fs.mkdirSync(path.join(root, 'deployments'));
      fs.writeFileSync(
        path.join(root, 'deployments', '8453.json'),
        JSON.stringify({ chainId: 8453, EnvMarket: '0x5fbdb2315678afecb367f032d93f642f64180aa3', startBlock: 42 }),
      );
      const cfg = loadEnv({ cwd: path.join(root), populateProcessEnv: false });
      expect(cfg.chainId).toBe(8453);
      expect(cfg.rpcUrl).toBe('https://mainnet.base.org');
      expect(cfg.addresses.market).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
      expect(cfg.addresses.token).toBe(BASE_USDC);
      expect(cfg.startBlock).toBe(42n);
      expect(roleKey(cfg, 'seller')).toBe(ANVIL_PK0);
      expect(cfg.roleAddresses.seller).toBe(ANVIL_ADDR0);
      expect(() => roleKey(cfg, 'juror1')).toThrow(/JUROR1_PK/);
    }));

  it('anvil chain + env overrides + ADDR/PK mismatch detection', () =>
    withCleanEnv(() => {
      const root = tmp();
      fs.writeFileSync(path.join(root, '.env'), `CHAIN_ID=31337\nSELLER_PK=${ANVIL_PK0}\nSELLER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8\n`);
      expect(() => loadEnv({ envFile: path.join(root, '.env'), populateProcessEnv: false })).toThrow(/SELLER_ADDR/);
      fs.writeFileSync(path.join(root, '.env'), `CHAIN_ID=31337\nMARKET_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3\n`);
      const cfg = loadEnv({ envFile: path.join(root, '.env'), populateProcessEnv: false });
      expect(cfg.chainId).toBe(31337);
      expect(cfg.rpcUrl).toBe('http://127.0.0.1:8545');
      expect(cfg.addresses.token).toBe(null);
      expect(() => loadEnv({ envFile: path.join(root, '.env'), populateProcessEnv: false, requireDeployment: true })).toThrow(/no deployment/);
    }));

  it('explorer links by chain', () => {
    const h = ('0x' + '12'.repeat(32)) as `0x${string}`;
    expect(explorerTxUrl(8453, h)).toBe(`https://basescan.org/tx/${h}`);
    expect(explorerTxUrl(84532, h)).toBe(`https://sepolia.basescan.org/tx/${h}`);
    expect(explorerTxUrl(31337, h)).toBe(null);
  });
});

describe.skipIf(!hasAnvil)('chain clients against a real local anvil node', () => {
  let proc: ChildProcess;
  const port = 18545 + Math.floor(Math.random() * 1000);

  beforeAll(async () => {
    proc = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('anvil did not start');
  });
  afterAll(() => proc?.kill());

  it('makeClients + waitTx sends and confirms a transfer', async () => {
    const config = withCleanEnv(() => loadEnv({ chainId: 31337, envFile: path.join(tmp(), '.env'), populateProcessEnv: false }));
    const clients = makeClients(ANVIL_PK0, { config, rpcUrl: `http://127.0.0.1:${port}` });
    expect(clients.account.address).toBe(ANVIL_ADDR0);
    const to = '0x000000000000000000000000000000000000dEaD';
    const hash = await clients.walletClient.sendTransaction({ to, value: parseEther('0.5') });
    const lines: string[] = [];
    const { receipt, url } = await waitTx(clients.publicClient, hash, { label: 'transfer', log: (l) => lines.push(l) });
    expect(receipt.status).toBe('success');
    expect(url).toBe(null);
    expect(lines[0]).toMatch(/^transfer: 0x[0-9a-f]{64} \(chain 31337\)/);
    expect(await clients.publicClient.getBalance({ address: to })).toBeGreaterThanOrEqual(parseEther('0.5'));
  });
});

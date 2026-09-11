import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256Hex } from '@envmarket/shared';
import type { Ctx } from '../src/context.ts';
import { listRationales, RATIONALE_TYPE, storeRationale } from '../src/rationales.ts';
import { BlobStore, PrivateStore } from '../src/store.ts';

// Foundry's published anvil test keys (#1, #2)
const juror = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const stranger = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const MARKET = '0x2fd644342296df7de57929fa87bd65c05fb415f8';
const COMMITMENT = `0x${'ab'.repeat(32)}`;
const EMPTY = { juror: '0x0000000000000000000000000000000000000000', vote: 0, revealed: false, commitment: `0x${'00'.repeat(32)}` };

function makeCtx(seat: { revealed: boolean; vote: number }): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tee-rationale-'));
  const seats = [{ juror: juror.address, commitment: COMMITMENT, ...seat }, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
  return {
    chain: { chainId: 31337, market: MARKET, getDispute: async () => ({ dispute: { round: 1 }, seats }) },
    blobs: new BlobStore(dir),
    priv: new PrivateStore(dir, new Uint8Array(32).fill(7)),
    cfg: { publicUrl: 'http://tee.test' },
  } as unknown as Ctx;
}

function doc(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: RATIONALE_TYPE,
    chainId: 31337,
    market: MARKET,
    disputeId: '1',
    round: 1,
    juror: juror.address.toLowerCase(),
    verdict: 'Uphold',
    confidence: 0.9,
    rationale: 'Task T2 collects 5 hidden tests; claim C10 promises at least 8.',
    citedFacts: ['T2 hidden test count is 5'],
    commitment: COMMITMENT,
    ...over,
  });
}
const sign = (text: string, who = juror) => who.signMessage({ message: { raw: sha256Hex(new TextEncoder().encode(text)) } });

describe('juror rationales', () => {
  it('stores the exact bytes and lists them once the juror has revealed', async () => {
    const ctx = makeCtx({ revealed: true, vote: 1 });
    const text = doc();
    const r = await storeRationale(ctx, 1n, { docJson: text, signature: await sign(text) });
    expect(r.sha256).toBe(sha256Hex(new TextEncoder().encode(text)));
    const listed = await listRationales(ctx, 1n);
    expect(listed.rationales).toHaveLength(1);
    expect(listed.rationales[0]!.docJson).toBe(text);
    expect(listed.rationales[0]!.juror).toBe(juror.address.toLowerCase());
  });

  it('refuses before the reveal is on-chain', async () => {
    const ctx = makeCtx({ revealed: false, vote: 0 });
    const text = doc();
    await expect(storeRationale(ctx, 1n, { docJson: text, signature: await sign(text) })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a signature by anyone but doc.juror', async () => {
    const ctx = makeCtx({ revealed: true, vote: 1 });
    const text = doc();
    await expect(storeRationale(ctx, 1n, { docJson: text, signature: await sign(text, stranger) })).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a verdict that differs from the revealed vote', async () => {
    const ctx = makeCtx({ revealed: true, vote: 2 });
    const text = doc();
    await expect(storeRationale(ctx, 1n, { docJson: text, signature: await sign(text) })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an address that is not seated', async () => {
    const ctx = makeCtx({ revealed: true, vote: 1 });
    const text = doc({ juror: stranger.address.toLowerCase() });
    await expect(storeRationale(ctx, 1n, { docJson: text, signature: await sign(text, stranger) })).rejects.toMatchObject({ status: 403 });
  });
});

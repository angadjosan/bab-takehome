import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonical, publishRationale, RATIONALE_TYPE, type RationaleDoc } from '../src/publish.ts';
import { sha256Hex } from '../src/rubric.ts';

// Foundry's published anvil test key #1
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const doc = {
  type: RATIONALE_TYPE,
  chainId: 31337,
  market: '0x2fd644342296df7de57929fa87bd65c05fb415f8',
  disputeId: '7',
  round: 1,
  juror: account.address.toLowerCase(),
  verdict: 'Uphold',
  confidence: 0.9,
  rationale: 'Task T2 collects 5 hidden tests.',
  citedFacts: [],
  screening: { passed: true, reasons: [] },
  model: { requested: 'm', resolved: 'm' },
  promptVersion: 'juror-v1',
  promptHash: '0x00',
  packetSha256: '0x00',
  commitment: '0x00',
  revealTx: '0x00',
  createdAt: '2026-09-11T00:00:00.000Z',
} as unknown as RationaleDoc;

/** A real HTTP server standing in for the TEE's /rationales endpoint (and a 404-only one). */
async function server(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

describe('publishRationale', () => {
  it('POSTs the exact canonical text with the juror signature over its sha256', async () => {
    const seen: { path?: string; docJson?: string; signature?: Hex } = {};
    const tee = await server((req, body, res) => {
      const b = JSON.parse(body) as { docJson: string; signature: Hex };
      Object.assign(seen, { path: req.url, ...b });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sha256: sha256Hex(new TextEncoder().encode(b.docJson)), url: 'x' }));
    });
    try {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurors-pub-'));
      const out = await publishRationale({ dataDir, teeUrl: tee.url, doc, log: () => undefined, sign: (h) => account.signMessage({ message: { raw: h } }) });
      expect(seen.path).toBe('/rationales/7');
      expect(seen.docJson).toBe(canonical(doc));
      expect(out.sha256).toBe(sha256Hex(new TextEncoder().encode(canonical(doc))));
      expect(await recoverMessageAddress({ message: { raw: out.sha256 }, signature: seen.signature! })).toBe(account.address);
    } finally {
      tee.close();
    }
  });

  it('falls back to PUT /blobs when the TEE has no /rationales endpoint', async () => {
    const methods: string[] = [];
    const tee = await server((req, body, res) => {
      methods.push(`${req.method} ${req.url}`);
      if (req.url?.startsWith('/rationales')) return void res.writeHead(404).end('{"error":"not found"}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sha256: sha256Hex(new TextEncoder().encode(body)) }));
    });
    try {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurors-pub-'));
      const out = await publishRationale({ dataDir, teeUrl: tee.url, doc, log: () => undefined, sign: (h) => account.signMessage({ message: { raw: h } }) });
      expect(methods).toEqual(['POST /rationales/7', 'PUT /blobs']);
      expect(out.blobUrl).toContain('/blobs/');
    } finally {
      tee.close();
    }
  });
});

#!/usr/bin/env node
// Records deployments/<chainId>.json from a forge broadcast file + live on-chain reads.
// Usage: node write-deployment.mjs <broadcast run-latest.json> <rpcUrl> <outFile>
import fs from "node:fs";
import path from "node:path";

const [, , runFile, rpc, outFile] = process.argv;
if (!runFile || !rpc || !outFile) {
  console.error("usage: write-deployment.mjs <run-latest.json> <rpc> <outFile>");
  process.exit(1);
}
const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
const creates = run.transactions.filter((t) => t.transactionType === "CREATE");
const addrOf = (name) => creates.find((t) => t.contractName === name)?.contractAddress;
const market = addrOf("EnvMarket");
const views = addrOf("EnvMarketViews");
if (!market || !views) throw new Error("EnvMarket/EnvMarketViews not found in broadcast");
const receipts = run.receipts ?? [];
if (receipts.length === 0 || receipts.some((r) => r.status !== "0x1" && r.status !== 1)) {
  throw new Error("missing or failed receipts in broadcast file");
}
const marketReceipt = receipts.find((r) => r.contractAddress?.toLowerCase() === market.toLowerCase());
const startBlock = Number(BigInt((marketReceipt ?? receipts[0]).blockNumber));

let id = 1;
async function rpcCall(method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const call = (to, data) => rpcCall("eth_call", [{ to, data }, "latest"]);
const word = (hex, i) => BigInt("0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const asAddr = (hex) => "0x" + hex.slice(-40);

// selectors: token() owner() viewsModule() params() symbol() decimals()
const chainId = Number(BigInt(await rpcCall("eth_chainId", [])));
const token = asAddr(await call(market, "0xfc0c546a"));
const owner = asAddr(await call(market, "0x8da5cb5b"));
const viewsOnChain = asAddr(await call(market, "0x487c2d2e"));
if (viewsOnChain.toLowerCase() !== views.toLowerCase()) throw new Error("viewsModule mismatch");
const p = await call(market, "0xcff0ab96");
const names = [
  "challengeWindow", "deliveryWindow", "refundCapBps", "penaltyThresholdBps", "penaltyBps", "feeBps",
  "bondFloor", "bondCap", "caseFee", "participationFee", "jurorStake", "minoritySlashBps",
  "nonRevealSlashBps", "commitWindow", "revealWindow", "verifierTimeout",
];
const params = Object.fromEntries(names.map((n, i) => [n, Number(word(p, i))]));
const symHex = await call(token, "0x95d89b41");
const symLen = Number(word(symHex, 1));
const tokenSymbol = Buffer.from(symHex.slice(2 + 128, 2 + 128 + symLen * 2), "hex").toString("utf8");
const tokenDecimals = Number(word(await call(token, "0x313ce567"), 0));

const out = {
  chainId,
  market,
  token,
  views,
  startBlock,
  deployer: run.transactions[0].transaction.from,
  owner,
  tokenSymbol,
  tokenDecimals,
  testToken: Boolean(addrOf("TestUSDC")),
  params,
  deployedAt: new Date().toISOString(),
  txs: receipts.map((r) => r.transactionHash),
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${outFile}`);
console.log(JSON.stringify(out, null, 2));

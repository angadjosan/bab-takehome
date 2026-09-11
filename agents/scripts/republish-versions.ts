// Republish listing versions with identical terms (fresh preview slot), then retire the old ones.
// Usage: npx tsx scripts/republish-versions.ts <oldVersionId> [<oldVersionId> ...]
import { loadAbi, loadEnv, makeClients } from '@envmarket/shared';

const env = loadEnv();
const abi = loadAbi('EnvMarket');
const market = env.addresses.market as `0x${string}`;
const { publicClient, walletClient, account } = makeClients('seller');

for (const arg of process.argv.slice(2)) {
  const oldId = BigInt(arg);
  const v = (await publicClient.readContract({ address: market, abi, functionName: 'getVersion', args: [oldId] })) as Record<string, unknown>;
  const input = {
    bundleHash: v.bundleHash, ciphertextHash: v.ciphertextHash, imageDigest: v.imageDigest,
    descriptionHash: v.descriptionHash, manifestHash: v.manifestHash, licenseHash: v.licenseHash,
    taskRoot: v.taskRoot, auditRoot: v.auditRoot, taskCount: v.taskCount, auditTaskCount: v.auditTaskCount,
    price: v.price, collateral: v.collateral, deliveryWindow: v.deliveryWindow, challengeWindow: v.challengeWindow, uri: v.uri,
  };
  const { result: newId, request } = await publicClient.simulateContract({
    account, address: market, abi, functionName: 'newVersion', args: [v.listingId, input],
  });
  const h1 = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: h1 });
  console.log(`listing ${v.listingId}: version ${oldId} -> ${newId} (${h1})`);
  const h2 = await walletClient.writeContract({ account, address: market, abi, functionName: 'setVersionActive', args: [oldId, false], chain: walletClient.chain });
  await publicClient.waitForTransactionReceipt({ hash: h2 });
  console.log(`retired version ${oldId} (${h2})`);
}

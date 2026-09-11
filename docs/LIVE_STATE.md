# Live state: Base Sepolia (84532)

Snapshot 2026-09-11 ~08:25 UTC. No demo purchases, disputes, finalizations or ratings were made:
the founder cancelled the demo run (next purchase id and next dispute id are both still 1).

- Market `EnvMarket` [0x2FD644342296df7dE57929fA87BD65c05fb415f8](https://sepolia.basescan.org/address/0x2fd644342296df7de57929fa87bd65c05fb415f8), token TestUSDC [0x6F3600d4…6CEB](https://sepolia.basescan.org/address/0x6f3600d4a42d0c6c52a8b9f04abf817ce7d56ceb) (6 decimals), start block 46670333
- TEE: Phala Cloud dstack CVM `envmarket-tee-prod` (Intel TDX, production OS dstack-0.5.9), app id `4099f96ab07de8666f8a63a0f48e40aa9883eda3`, endpoint https://4099f96ab07de8666f8a63a0f48e40aa9883eda3-8080.dstack-pha-prod5.phala.network, signer `0x51EDE7C81B66c4395AEfbdb2d626928018D393c7`, verify at https://trust.phala.com/app/4099f96ab07de8666f8a63a0f48e40aa9883eda3
- Web: https://rl-env-market.vercel.app

## Listings

| Listing | Environment | Live version | Status | Web |
|---|---|---|---|---|
| 1 | py-repair-kit@1.0.0 (5 tasks + 2 audit) | **5** | active; verified preview attached (3 was retired: its preview deadline passed before the TEE fix) | https://rl-env-market.vercel.app/listing/5 |
| 2 | humanevalfix-8@1.0.0 (8 tasks + 2 audit) | **6** | active; verified preview attached (4 was retired: its preview deadline passed before the TEE fix) | https://rl-env-market.vercel.app/listing/6 |

Terms for every version: price 100 tUSDC, collateral 100 tUSDC per sale, challenge window 300 s,
delivery window 600 s. The seller (`0x1D4E…B883`) has 250 tUSDC collateral staked (none reserved).

Versions 1 and 2 (the first versions of listings 1 and 2) are **deactivated**. Their signed
reports (v1 `0x65814fc6…e082`, v2 `0x63624d63…dc09`) are valid and attached, but all 21/21 and
30/30 panel episodes were `infra_failure`. Only the validator ran, so the 0% pass@1 figures in them
mean nothing. The same bundles were re-listed as versions 3 and 4 (identical commitments), and the
new previews are paid.

**Pending:** versions 3 and 4 get their reports once the TEE image with the sandbox fix
(commit "tee+harness: network namespace as the primary sandbox barrier…") is built and
deployed as an update of the same app id (same signer). At that point each preview is started
with `POST /preview/<versionId>?async=1`. Each preview fee can be reclaimed by the seller only
after `previewDeadline` (paid + 3600 s, around 09:17 UTC). A report attached after that deadline
is still accepted until the seller reclaims.

## Setup transactions

| Step | Tx |
|---|---|
| owner `setRunner(TEE, true)` | [0x1b1bca9c…](https://sepolia.basescan.org/tx/0x1b1bca9c25b5f6d29e54ad80498c64b1145cb1a4c567a7a0b5c2e08b59d9d87d) |
| owner `setRelay(TEE, true)` | [0x80115baa…](https://sepolia.basescan.org/tx/0x80115baa48cd480150d0424d092ae6b14beddf54191baa387b4ccf40212d5e0b) |
| owner `setVerifier(TEE, true)` | [0x1510aaa5…](https://sepolia.basescan.org/tx/0x1510aaa5a0577b1db2f6a9489fe05decdf44ca7730e46d6ba12f3f057ad72135) |
| owner → TEE 0.0001 ETH (gas) | [0x8ceee7d7…](https://sepolia.basescan.org/tx/0x8ceee7d7cccfd291f5d373d512bac0409213a86ef960a8d31f87383701547f05) |
| seller `createListing` → listing 1 / version 1 (py-repair-kit) | [0x0e14e757…](https://sepolia.basescan.org/tx/0x0e14e757d41bf1d1c1ccc308b22779bd52ebe92b9e533f038677c5ffd1158ae6) |
| seller `createListing` → listing 2 / version 2 (humanevalfix-8) | [0xd52416bc…](https://sepolia.basescan.org/tx/0xd52416bc8999b676f1931c09df210d5f7cc6cc43fde37107e89c9dd6abce6af8) |
| seller `approve` 250 (collateral) | [0x421bb6a5…](https://sepolia.basescan.org/tx/0x421bb6a5325a1a3d91637fb7c3da776da3013aa0d10aa11831e2fc9bb58902c2) |
| seller `depositCollateral(250)` | [0xd5515ffe…](https://sepolia.basescan.org/tx/0xd5515ffeea8baf2aedad143b87e7c3c2c7d7f4534331975da1ac34db322a0d41) |
| v1 preview: `approve` / `requestPreview` 2.28 | [0x555fc2ec…](https://sepolia.basescan.org/tx/0x555fc2ec621b092af15c9b5d056a2410973cfa73a34e1a5f8ffdbebc6a84d6b8) / [0x4f30b8a9…](https://sepolia.basescan.org/tx/0x4f30b8a93bf2afb1a74a499be56a4fb49b02ba264afff4b0eb5518172d33ab23) |
| v1 `attachReport` (by the TEE) | [0xa0b35ecf…](https://sepolia.basescan.org/tx/0xa0b35ecfc52cc0f816b893af31e4af450d6239098b9b8155da121e4c1ca84036) |
| v2 preview: `approve` / `requestPreview` 3.22 | [0xd496d983…](https://sepolia.basescan.org/tx/0xd496d983925d18ea019af6b2ac8845081bf13311e53b2215407d99cf3a2adad1) / [0xa31b1839…](https://sepolia.basescan.org/tx/0xa31b18399262cf13e0cda710b67e4c4362a5be95948b3d69397592974f5ff0f7) |
| v2 `attachReport` (by the TEE) | [0x52bd057f…](https://sepolia.basescan.org/tx/0x52bd057fa4881ce4efebc0e8a3bab0d0c4933e33b3c4d47dbc1ae801e005b8aa) |
| seller `setVersionActive(1, false)` | [0xebf1b391…](https://sepolia.basescan.org/tx/0xebf1b39103b0f1f620b0913943826a37f667c91813321f0276ef4b3ce000b494) |
| seller `setVersionActive(2, false)` | [0x871da17a…](https://sepolia.basescan.org/tx/0x871da17a65f509a951e4115016eb24d0df3fcfabe92fe77b758375c2fbace292) |
| seller `newVersion(listing 1)` → version 3 | [0x8b3ee3cc…](https://sepolia.basescan.org/tx/0x8b3ee3ccbb710bfb823c47ca53d7a329776fd54d5f3cb03c6df588107e8b3606) |
| seller `newVersion(listing 2)` → version 4 | [0x98eb68bb…](https://sepolia.basescan.org/tx/0x98eb68bb851ad168b4cb37cd70ff9bc117881f7bedeb22d32816778534d38ae6) |
| v3 preview: `approve` / `requestPreview` 2.28 | [0x7fd18f39…](https://sepolia.basescan.org/tx/0x7fd18f39ceab8d269a4915d9b542ef758f0ef1721cee2eade25c273122bc7c92) / [0x62b02ad2…](https://sepolia.basescan.org/tx/0x62b02ad2683b95fe53bc1cd5754d03f790ab703afcc66c8c3d3a1836b26efa9d) |
| v4 preview: `approve` / `requestPreview` 3.22 | [0x38f38ab1…](https://sepolia.basescan.org/tx/0x38f38ab129847e526688ba63db74b58688e6801a84c1c3d8ca0ffd897a979d90) / [0x0c39456a…](https://sepolia.basescan.org/tx/0x0c39456afea4be905de8828663934b5339e7a6acbfd80686ee6bc70c69270d90) |

TEE `/attestation` reports `signerRoles: {runner: true, relay: true, verifier: true}`.

## Balances and accounting

The market's tUSDC balance equals the sum of its buckets: collateral 250 + juror stake 120 (3 × 40)
+ claimable 5.5 (released v1/v2 preview fees, owed to the operator/deployer) + escrowed preview fees
5.5 (v3 + v4) = **381**. Escrow, bonds, treasury and reserve are all 0.

| Account | tUSDC | ETH |
|---|---|---|
| seller `0x1D4E…B883` | 9739 | ~0.00006 |
| buyer `0xdc28…fE1d` / buyer2 `0x91Db…B651` | 10000 / 10000 | 0.00007 each |
| jurors 1–3 | 9960 each (+40 staked each) | ~0.000069 each |
| deployer / owner `0xF218…3784` | 0 (+5.5 claimable) | ~0.00039 |
| TEE signer `0x51ED…93c7` | 0 | ~0.0000988 |

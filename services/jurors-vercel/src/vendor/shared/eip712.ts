/**
 * EIP-712 typed data for EnvMarket (domain name "EnvMarket", version "1") plus the EIP-191
 * juror evidence-auth challenge used by the TEE `/evidence/:disputeId` endpoint.
 */
import {
  getAddress,
  hashTypedData,
  isAddressEqual,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';

export const EIP712_NAME = 'EnvMarket';
export const EIP712_VERSION = '1';

export interface EnvMarketDomain {
  name: typeof EIP712_NAME;
  version: typeof EIP712_VERSION;
  chainId: number;
  verifyingContract: Address;
}

export function envMarketDomain(chainId: number | bigint, verifyingContract: Address): EnvMarketDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: Number(chainId), verifyingContract: getAddress(verifyingContract) };
}

export const envMarketTypes = {
  PreviewReport: [
    { name: 'versionId', type: 'uint256' },
    { name: 'bundleHash', type: 'bytes32' },
    { name: 'reportHash', type: 'bytes32' },
  ],
  DeliveryReceipt: [
    { name: 'purchaseId', type: 'uint256' },
    { name: 'buyerEncPubKey', type: 'bytes32' },
    { name: 'ciphertextHash', type: 'bytes32' },
    { name: 'wrappedKeyHash', type: 'bytes32' },
    { name: 'wrapperHash', type: 'bytes32' },
  ],
  MechanicalFinding: [
    { name: 'disputeId', type: 'uint256' },
    { name: 'upheld', type: 'bool' },
    { name: 'confirmedMask', type: 'uint256' },
    { name: 'findingsHash', type: 'bytes32' },
  ],
} as const;

export type EnvMarketPrimaryType = keyof typeof envMarketTypes;

export interface PreviewReportMessage {
  versionId: bigint;
  bundleHash: Hex;
  reportHash: Hex;
}
export interface DeliveryReceiptMessage {
  purchaseId: bigint;
  buyerEncPubKey: Hex;
  ciphertextHash: Hex;
  wrappedKeyHash: Hex;
  wrapperHash: Hex;
}
export interface MechanicalFindingMessage {
  disputeId: bigint;
  upheld: boolean;
  confirmedMask: bigint;
  findingsHash: Hex;
}

export interface EnvMarketMessages {
  PreviewReport: PreviewReportMessage;
  DeliveryReceipt: DeliveryReceiptMessage;
  MechanicalFinding: MechanicalFindingMessage;
}

function typesFor<P extends EnvMarketPrimaryType>(primaryType: P) {
  return { [primaryType]: envMarketTypes[primaryType] } as { [K in P]: (typeof envMarketTypes)[K] };
}

/** EIP-712 digest (what the contract recovers against). */
export function envMarketTypedDataHash<P extends EnvMarketPrimaryType>(
  domain: EnvMarketDomain,
  primaryType: P,
  message: EnvMarketMessages[P],
): Hex {
  return hashTypedData({ domain, types: typesFor(primaryType), primaryType, message } as never);
}

/** Sign typed data with a local account (private key / mnemonic / KMS-derived HD account). */
export async function signEnvMarket<P extends EnvMarketPrimaryType>(
  account: LocalAccount,
  domain: EnvMarketDomain,
  primaryType: P,
  message: EnvMarketMessages[P],
): Promise<Hex> {
  if (!account.signTypedData) throw new Error('account cannot sign typed data');
  return account.signTypedData({ domain, types: typesFor(primaryType), primaryType, message } as never);
}

/** Recover the signer address of an EnvMarket typed-data signature. */
export async function recoverEnvMarketSigner<P extends EnvMarketPrimaryType>(
  domain: EnvMarketDomain,
  primaryType: P,
  message: EnvMarketMessages[P],
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ domain, types: typesFor(primaryType), primaryType, message, signature } as never);
}

/** True iff `signature` over `message` was produced by `expected`. Never throws on bad sigs. */
export async function verifyEnvMarketSignature<P extends EnvMarketPrimaryType>(
  domain: EnvMarketDomain,
  primaryType: P,
  message: EnvMarketMessages[P],
  signature: Hex,
  expected: Address,
): Promise<boolean> {
  try {
    return isAddressEqual(await recoverEnvMarketSigner(domain, primaryType, message, signature), expected);
  } catch {
    return false;
  }
}

export const signPreviewReport = (a: LocalAccount, d: EnvMarketDomain, m: PreviewReportMessage) => signEnvMarket(a, d, 'PreviewReport', m);
export const signDeliveryReceipt = (a: LocalAccount, d: EnvMarketDomain, m: DeliveryReceiptMessage) => signEnvMarket(a, d, 'DeliveryReceipt', m);
export const signMechanicalFinding = (a: LocalAccount, d: EnvMarketDomain, m: MechanicalFindingMessage) => signEnvMarket(a, d, 'MechanicalFinding', m);

/**
 * EIP-191 challenge a seated juror signs to fetch a case packet from the TEE.
 * Line-oriented, human-readable, all fields bound.
 */
export function evidenceAuthMessage(args: {
  chainId: number;
  market: Address;
  disputeId: bigint | number | string;
  juror: Address;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    'EnvMarket evidence access',
    `chainId: ${args.chainId}`,
    `market: ${args.market.toLowerCase()}`,
    `disputeId: ${BigInt(args.disputeId).toString()}`,
    `juror: ${args.juror.toLowerCase()}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${args.expiresAt}`,
  ].join('\n');
}

export async function signEvidenceAuth(account: LocalAccount, message: string): Promise<Hex> {
  return account.signMessage({ message });
}

/** Recover and check an evidence-auth signature (also checks expiry). */
export async function verifyEvidenceAuth(args: {
  message: string;
  signature: Hex;
  juror: Address;
  nowSec?: number;
}): Promise<boolean> {
  const m = /\nexpiresAt: (\d+)$/.exec(args.message);
  if (!m) return false;
  if (Number(m[1]) < (args.nowSec ?? Math.floor(Date.now() / 1000))) return false;
  if (!args.message.includes(`\njuror: ${args.juror.toLowerCase()}\n`)) return false;
  try {
    return isAddressEqual(await recoverMessageAddress({ message: args.message, signature: args.signature }), args.juror);
  } catch {
    return false;
  }
}

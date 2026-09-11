/**
 * Service key material.
 *
 * In the TEE (EigenCompute): the KMS injects `MNEMONIC` (deterministic per app id, stable across
 * upgrades). From it we derive:
 *   - the secp256k1 signer at m/44'/60'/0'/0/0 (runner / relay / verifier role in EnvMarket);
 *   - an X25519 keypair sellers wrap bundle/audit keys to:
 *       sk = HKDF-SHA256(ikm = BIP39 seed, salt = "", info = "envmarket.tee.x25519.v1", L = 32)
 *   - a storage key for private records at rest:
 *       k  = HKDF-SHA256(ikm = BIP39 seed, salt = "", info = "envmarket.tee.storage.v1", L = 32)
 *
 * Local dev (no MNEMONIC): the signer is RUNNER_PK from the repo .env and the same HKDF
 * derivations use the 32 private-key bytes as ikm. Reports label this `none-local-dev`.
 */
import { pbkdf2Sync } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, type Hex, type LocalAccount } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

export const SIGNER_PATH = "m/44'/60'/0'/0/0" as const;
export const X25519_INFO = 'envmarket.tee.x25519.v1';
export const STORAGE_INFO = 'envmarket.tee.storage.v1';

export interface ServiceKeys {
  source: 'kms-mnemonic' | 'local-dev-runner-pk';
  account: LocalAccount;
  encSecretKey: Uint8Array;
  encPublicKey: Hex;
  storageKey: Uint8Array;
}

/** BIP39 seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase). */
export function bip39Seed(mnemonic: string, passphrase = ''): Uint8Array {
  const m = mnemonic.normalize('NFKD').trim().split(/\s+/).join(' ');
  return new Uint8Array(pbkdf2Sync(Buffer.from(m, 'utf8'), Buffer.from('mnemonic' + passphrase.normalize('NFKD'), 'utf8'), 2048, 64, 'sha512'));
}

function derive(ikm: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), new TextEncoder().encode(info), 32);
}

function fromIkm(ikm: Uint8Array, account: LocalAccount, source: ServiceKeys['source']): ServiceKeys {
  const encSecretKey = derive(ikm, X25519_INFO);
  return {
    source,
    account,
    encSecretKey,
    encPublicKey: bytesToHex(x25519.getPublicKey(encSecretKey)),
    storageKey: derive(ikm, STORAGE_INFO),
  };
}

export function keysFromMnemonic(mnemonic: string): ServiceKeys {
  const account = mnemonicToAccount(mnemonic, { path: SIGNER_PATH });
  return fromIkm(bip39Seed(mnemonic), account, 'kms-mnemonic');
}

export function keysFromPrivateKey(pk: Hex): ServiceKeys {
  return fromIkm(hexToBytes(pk), privateKeyToAccount(pk), 'local-dev-runner-pk');
}

/** MNEMONIC (TEE) wins; otherwise RUNNER_PK (local dev). */
export function loadServiceKeys(env: Record<string, string | undefined>): ServiceKeys {
  if (env.MNEMONIC && env.MNEMONIC.trim().split(/\s+/).length >= 12) return keysFromMnemonic(env.MNEMONIC);
  const pk = env.RUNNER_PK;
  if (!pk) throw new Error('no key material: set MNEMONIC (EigenCompute KMS) or RUNNER_PK (local dev)');
  return keysFromPrivateKey((pk.startsWith('0x') ? pk : `0x${pk}`).toLowerCase() as Hex);
}

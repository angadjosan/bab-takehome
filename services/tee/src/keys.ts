/**
 * Service key material. One root secret per deployment, selected by TEE_VENDOR
 * (eigencompute | phala | local; auto-detected when unset, see `teeVendor`).
 *
 * EigenCompute: the KMS injects `MNEMONIC` (deterministic per app id, stable across upgrades).
 *   signer = m/44'/60'/0'/0/0 of the mnemonic; ikm = BIP39 seed.
 * Phala Cloud (dstack, Intel TDX): the guest agent at /var/run/dstack.sock derives a 32-byte
 *   secp256k1 key from the app's KMS root key, deterministic per (app_id, path, purpose) and stable
 *   across `phala deploy --cvm-id` updates. signer = that key; ikm = the same 32 bytes. The KMS
 *   signature chain over the key is kept for verifiers. SDK: @phala/dstack-sdk 0.5.8 (v0 GetKey).
 * Local dev: signer = RUNNER_PK from the repo .env; ikm = its 32 bytes. Reports say `none-local-dev`.
 *
 * From the ikm, in every mode:
 *   - an X25519 keypair sellers wrap bundle/audit keys to:
 *       sk = HKDF-SHA256(ikm, salt = "", info = "envmarket.tee.x25519.v1", L = 32)
 *   - a storage key for private records at rest:
 *       k  = HKDF-SHA256(ikm, salt = "", info = "envmarket.tee.storage.v1", L = 32)
 */
import { pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, type Hex, type LocalAccount } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

export const SIGNER_PATH = "m/44'/60'/0'/0/0" as const;
export const X25519_INFO = 'envmarket.tee.x25519.v1';
export const STORAGE_INFO = 'envmarket.tee.storage.v1';
/** dstack GetKey inputs. Changing either changes the signer (and every derived key). */
export const DSTACK_KEY_PATH = 'envmarket/tee/v1';
export const DSTACK_KEY_PURPOSE = 'envmarket.tee.root';
export const DSTACK_SOCKET = '/var/run/dstack.sock';

export type TeeVendor = 'eigencompute' | 'phala' | 'local';

export interface DstackKeyInfo {
  path: string;
  purpose: string;
  /** KMS signature chain returned by GetKey (hex): app-key signature over the derived key, then the KMS root over the app key. */
  signatureChain: Hex[];
}

export interface ServiceKeys {
  source: 'kms-mnemonic' | 'dstack-kms' | 'dstack-simulator' | 'local-dev-runner-pk';
  account: LocalAccount;
  encSecretKey: Uint8Array;
  encPublicKey: Hex;
  storageKey: Uint8Array;
  dstack?: DstackKeyInfo;
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

const hasMnemonic = (env: Record<string, string | undefined>) => !!env.MNEMONIC && env.MNEMONIC.trim().split(/\s+/).length >= 12;

export function keysFromMnemonic(mnemonic: string): ServiceKeys {
  const account = mnemonicToAccount(mnemonic, { path: SIGNER_PATH });
  return fromIkm(bip39Seed(mnemonic), account, 'kms-mnemonic');
}

export function keysFromPrivateKey(pk: Hex): ServiceKeys {
  return fromIkm(hexToBytes(pk), privateKeyToAccount(pk), 'local-dev-runner-pk');
}

/**
 * Which dstack endpoint to use. Inside a Phala CVM it is the mounted socket. DSTACK_SIMULATOR_ENDPOINT
 * (tests / laptop) points at the open-source dstack simulator; keys and attestation from it are
 * labeled as simulated and never reported as a TEE.
 */
export function dstackEndpoint(env: Record<string, string | undefined>): { endpoint: string; simulated: boolean } {
  if (env.DSTACK_SIMULATOR_ENDPOINT) return { endpoint: env.DSTACK_SIMULATOR_ENDPOINT, simulated: true };
  return { endpoint: env.DSTACK_SOCKET || DSTACK_SOCKET, simulated: false };
}

export async function keysFromDstack(endpoint: string, simulated = false): Promise<ServiceKeys> {
  const { DstackClient } = await import('@envmarket/dstack');
  const r = await new DstackClient(endpoint).getKey(DSTACK_KEY_PATH, DSTACK_KEY_PURPOSE);
  if (r.key.length !== 32) throw new Error(`dstack GetKey returned ${r.key.length} bytes, expected 32`);
  // privateKeyToAccount rejects a scalar outside [1, n-1]
  const k = fromIkm(r.key, privateKeyToAccount(bytesToHex(r.key)), simulated ? 'dstack-simulator' : 'dstack-kms');
  return { ...k, dstack: { path: DSTACK_KEY_PATH, purpose: DSTACK_KEY_PURPOSE, signatureChain: r.signature_chain.map((s) => bytesToHex(s)) } };
}

/**
 * TEE_VENDOR if set; otherwise MNEMONIC present → eigencompute; the dstack socket exists → phala;
 * else local. No silent fallback: an explicit vendor whose key source is missing fails at startup.
 */
export function teeVendor(env: Record<string, string | undefined>, socketExists: (p: string) => boolean = existsSync): TeeVendor {
  const v = env.TEE_VENDOR?.trim().toLowerCase();
  if (v) {
    if (v === 'eigencompute' || v === 'phala' || v === 'local') return v;
    throw new Error(`TEE_VENDOR must be eigencompute | phala | local (got "${env.TEE_VENDOR}")`);
  }
  if (hasMnemonic(env)) return 'eigencompute';
  if (socketExists(env.DSTACK_SOCKET || DSTACK_SOCKET)) return 'phala';
  return 'local';
}

/** Keys for the selected vendor. Throws when that vendor's key source is absent. */
export async function loadServiceKeysFor(vendor: TeeVendor, env: Record<string, string | undefined>): Promise<ServiceKeys> {
  if (vendor === 'eigencompute') {
    if (!hasMnemonic(env)) throw new Error('TEE_VENDOR=eigencompute but no MNEMONIC (injected by the EigenCompute KMS)');
    return keysFromMnemonic(env.MNEMONIC!);
  }
  if (vendor === 'phala') {
    const { endpoint, simulated } = dstackEndpoint(env);
    if (!simulated && !existsSync(endpoint)) throw new Error(`TEE_VENDOR=phala but the dstack socket ${endpoint} is not mounted`);
    return keysFromDstack(endpoint, simulated);
  }
  const pk = env.RUNNER_PK;
  if (!pk) throw new Error('TEE_VENDOR=local needs RUNNER_PK (local dev signer)');
  return keysFromPrivateKey((pk.startsWith('0x') ? pk : `0x${pk}`).toLowerCase() as Hex);
}

/** Synchronous variant (MNEMONIC wins; otherwise RUNNER_PK). Kept for tests and scripts. */
export function loadServiceKeys(env: Record<string, string | undefined>): ServiceKeys {
  if (hasMnemonic(env)) return keysFromMnemonic(env.MNEMONIC!);
  const pk = env.RUNNER_PK;
  if (!pk) throw new Error('no key material: set MNEMONIC (EigenCompute KMS) or RUNNER_PK (local dev)');
  return keysFromPrivateKey((pk.startsWith('0x') ? pk : `0x${pk}`).toLowerCase() as Hex);
}

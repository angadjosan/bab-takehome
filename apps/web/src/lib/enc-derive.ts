"use client";

import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { CHAIN_ID } from "./config";
import type { EncKey } from "./crypto";
import { useEncKeys } from "./keys";

/**
 * Buyer encryption key derived from the wallet, so buyers never generate, back up or import a key.
 *
 * The wallet signs a fixed EIP-191 message; X25519 secret = HKDF-SHA256(signature). Standard secp256k1
 * wallets, including Privy embedded wallets, sign deterministically (RFC 6979), so signing the same
 * message again on any device yields the same key. The derived key is also cached in this browser's
 * key store: if a wallet ever produced a different signature (e.g. a smart-contract wallet), purchases
 * made from this browser still decrypt, and the purchase page says when a re-derived key doesn't match.
 */
export function encKeyMessage(address: Address): string {
  return `EnvMarket encryption key v1 for ${address.toLowerCase()} on ${CHAIN_ID}`;
}

const enc = new TextEncoder();

/** Async so the curve and KDF code only download when a key is actually derived (on Buy / Unlock). */
export async function encKeyFromSignature(signature: Hex, address: Address): Promise<EncKey> {
  const [{ hkdf }, { sha256 }, { x25519 }] = await Promise.all([import("@noble/hashes/hkdf.js"), import("@noble/hashes/sha2.js"), import("@noble/curves/ed25519.js")]);
  const sk = hkdf(sha256, hexToBytes(signature), enc.encode("envmarket.buyer-enc.v1"), enc.encode(`${CHAIN_ID}:${address.toLowerCase()}`), 32);
  return { publicKey: bytesToHex(x25519.getPublicKey(sk)), secretKey: bytesToHex(sk), createdAt: Date.now(), label: walletKeyLabel(address) };
}

export const walletKeyLabel = (address: Address) => `wallet:${address.toLowerCase()}:${CHAIN_ID}`;

/** The connected wallet's encryption key: cached if derived before in this browser, else derived by one signature. */
export function useWalletEncKey() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { keys, add } = useEncKeys();
  const cached = address ? keys.find((k) => k.label === walletKeyLabel(address)) : undefined;

  async function derive(opts: { fresh?: boolean } = {}): Promise<EncKey> {
    if (!address) throw new Error("Connect a wallet first.");
    if (cached && !opts.fresh) return cached;
    const signature = await signMessageAsync({ message: encKeyMessage(address) });
    const k = await encKeyFromSignature(signature, address);
    add(k);
    return k;
  }
  return { key: cached, derive };
}

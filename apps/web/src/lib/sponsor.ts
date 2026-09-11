"use client";

import { createContext } from "react";
import type { Address, Hex } from "viem";

/**
 * Gas-sponsored sending, provided by the Privy tree (components/privy-login.tsx) when
 * NEXT_PUBLIC_PRIVY_SPONSOR_GAS=1. useTx sends through it when the active account is the user's
 * Privy embedded wallet; everything else goes through wagmi's writeContract.
 */
export type Sponsor = {
  canSponsor: (from: Address) => boolean;
  send: (tx: { to: Address; data: Hex }, from: Address) => Promise<Hex>;
};

export const SponsorCtx = createContext<Sponsor | null>(null);

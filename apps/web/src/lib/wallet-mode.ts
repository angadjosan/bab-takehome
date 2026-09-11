"use client";

import { useSyncExternalStore } from "react";
import { CHAIN_ID } from "./config";

/**
 * Wallet configuration.
 *
 * - Privy (`NEXT_PUBLIC_PRIVY_APP_ID`, optional `NEXT_PUBLIC_PRIVY_CLIENT_ID`) is the wallet and payment
 *   path: email / Google / external-wallet login with an embedded EVM wallet created on login.
 * - `NEXT_PUBLIC_PRIVY_SPONSOR_GAS=1` sends contract writes from the embedded wallet through Privy's
 *   native gas sponsorship (the Privy dashboard must have "App pays" enabled for the chain).
 * - Dev tools (the burner-key wallet, for testing several roles in one browser) are on for the local
 *   anvil chain, or when the page is opened with `?dev=1` (remembered for the tab; `?dev=0` clears).
 *   Dev-tools mode uses plain wagmi connectors instead of Privy.
 */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
export const PRIVY_CLIENT_ID = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || "";
export const PRIVY_SPONSOR_GAS = process.env.NEXT_PUBLIC_PRIVY_SPONSOR_GAS === "1";

const DEV_KEY = "envmarket.devtools";
const LOCAL = CHAIN_ID === 31337;

function readDevTools(): boolean {
  if (LOCAL) return true;
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("dev");
    if (q === "1") window.sessionStorage.setItem(DEV_KEY, "1");
    if (q === "0") window.sessionStorage.removeItem(DEV_KEY);
    return window.sessionStorage.getItem(DEV_KEY) === "1";
  } catch {
    return false;
  }
}

const noSubscribe = () => () => {};

/** True on anvil or with ?dev=1. Server render assumes off (except on anvil) and corrects after hydration. */
export function useDevTools(): boolean {
  return useSyncExternalStore(noSubscribe, readDevTools, () => LOCAL);
}

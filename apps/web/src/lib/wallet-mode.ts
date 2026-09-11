"use client";

import { CHAIN_ID } from "./config";

/**
 * Wallet configuration.
 *
 * - Every chain except local anvil signs in through Privy (`NEXT_PUBLIC_PRIVY_APP_ID`, optional
 *   `NEXT_PUBLIC_PRIVY_CLIENT_ID`): email or external-wallet login, with an embedded EVM wallet created
 *   for users who sign in without one. A non-local build without an app id shows a disabled "Sign in"
 *   and logs a console error; it never falls back to browser-wallet connectors.
 * - `NEXT_PUBLIC_PRIVY_SPONSOR_GAS=1` sends contract writes from the embedded wallet through Privy's
 *   native gas sponsorship (the Privy dashboard must have "App pays" enabled for the chain).
 * - Dev tools (plain wagmi browser connectors plus the burner-key wallet, for testing several roles in
 *   one browser) exist only on the local anvil chain (31337). Hosted builds have no switch for them.
 */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
export const PRIVY_CLIENT_ID = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || "";
export const PRIVY_SPONSOR_GAS = process.env.NEXT_PUBLIC_PRIVY_SPONSOR_GAS === "1";

/** Local anvil chain: plain wagmi + burner keys instead of Privy. Fixed at build time, so server and client agree. */
export const DEV_TOOLS = CHAIN_ID === 31337;

import { CHAIN_ID, IS_MAINNET } from "./config";

/**
 * Payment-token metadata. Symbol and decimals are read from the token contract at startup
 * (TokenMetaProvider in components/providers.tsx) and written here; formatting helpers read
 * this module-level value. The defaults only cover the first paint.
 */
export const tokenMeta = {
  symbol: CHAIN_ID === 8453 ? "USDC" : "tUSDC",
  decimals: 6,
  name: "",
  hasFaucet: false,
  loaded: false,
};

export function setTokenMeta(m: Partial<typeof tokenMeta>) {
  Object.assign(tokenMeta, m);
}

/** One-line disclosure of what the payment token is worth. */
export function tokenValueNote() {
  if (IS_MAINNET) return `Payments use real ${tokenMeta.symbol} on Base mainnet. Demo amounts are deliberately small.`;
  return `Payments use ${tokenMeta.symbol}, a test token with no monetary value.`;
}

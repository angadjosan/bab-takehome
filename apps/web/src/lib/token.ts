import { CHAIN_NAME, IS_MAINNET } from "./config";

/**
 * Payment-token metadata. Symbol and decimals are read from the token contract at startup
 * (TokenMetaProvider in components/providers.tsx) and written here; formatting helpers read
 * this module-level value. Until the read lands the symbol is blank (no guessed name is shown);
 * decimals start at the ERC-20/USDC 6 so first-paint amounts aren't raw integers, and are replaced
 * (with a remount) if the contract says otherwise.
 */
export const tokenMeta = {
  symbol: "",
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
  if (IS_MAINNET) return `Payments use real ${tokenMeta.symbol} on ${CHAIN_NAME}.`;
  return `${CHAIN_NAME} testnet: payments use ${tokenMeta.symbol}, a test token with no value.`;
}

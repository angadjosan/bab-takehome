import { deployment } from "./config";

/**
 * Payment-token metadata. Symbol and decimals are read from the token contract at startup
 * (TokenMetaProvider in components/providers.tsx) and written here; formatting helpers read
 * this module-level value. First paint uses the deployment file's recorded `tokenSymbol` /
 * `tokenDecimals` (blank symbol and ERC-20/USDC 6 decimals when the file has none); the contract
 * read replaces them, with a remount, if they differ.
 */
const recorded = deployment?.raw ?? {};

export const tokenMeta = {
  symbol: typeof recorded.tokenSymbol === "string" ? recorded.tokenSymbol : "",
  decimals: typeof recorded.tokenDecimals === "number" ? recorded.tokenDecimals : 6,
  name: "",
  hasFaucet: false,
  loaded: false,
};

export function setTokenMeta(m: Partial<typeof tokenMeta>) {
  Object.assign(tokenMeta, m);
}

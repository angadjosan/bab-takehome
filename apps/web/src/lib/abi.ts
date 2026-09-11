import { erc20Abi, type Abi } from "viem";
import { generatedAbis } from "@/generated/contracts";

/**
 * Contract ABIs, synced from the compiled contracts by `scripts/sync-web.sh` into
 * src/generated/contracts.ts. The market ABI is the union of EnvMarket and EnvMarketViews
 * (EnvMarket delegatecalls the views module, so all reads go to the EnvMarket address).
 *
 * If nothing has been synced, the market ABI is empty (the app then shows "not deployed")
 * and the token falls back to the standard ERC-20 ABI; nothing is guessed.
 */

function pick(name: string): Abi | null {
  const abi = generatedAbis[name];
  return Array.isArray(abi) && abi.length ? (abi as Abi) : null;
}

export const marketAbi: Abi = pick("EnvMarket") ?? [];
export const tokenAbi: Abi = pick("TestUSDC") ?? (erc20Abi as Abi);
export const HAS_MARKET_ABI = marketAbi.length > 0;

export function hasFunction(abi: Abi, name: string) {
  return abi.some((x) => x.type === "function" && x.name === name);
}

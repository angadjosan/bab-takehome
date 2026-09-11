"use client";

import { useSyncExternalStore } from "react";
import { createWalletClient, fromHex, getAddress, http, isHex, numberToHex, SwitchChainError, type Address, type EIP1193RequestFn, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createConnector } from "wagmi";
import { RPC_URL } from "./config";

/**
 * "Burner key" wallet: the user pastes a private key of a throwaway wallet, and transactions are
 * signed in this tab with a viem local account. It is offered only on the local anvil chain (dev
 * tools). The user's own key, nothing simulated, but the key sits in sessionStorage (this tab only,
 * gone when the tab closes), so it is only for wallets holding tiny balances. Several keys can be
 * added and switched between, which lets one browser act as buyer, seller, juror and observer.
 */

export type Burner = { address: Address; privateKey: Hex; label: string; addedAt: number };
type State = { burners: Burner[]; active: Address | null; connected: boolean };

const KEY = "envmarket.burner.v1";
const EVT = "envmarket-burner-changed";
const EMPTY: State = { burners: [], active: null, connected: false };

function read(): State {
  if (typeof window === "undefined") return EMPTY;
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) || "null") as State | null;
    return v && Array.isArray(v.burners) ? v : EMPTY;
  } catch {
    return EMPTY;
  }
}

let snap: State = EMPTY;
let snapRaw = "";
function getSnapshot(): State {
  let raw = "";
  try {
    raw = window.sessionStorage.getItem(KEY) || "";
  } catch {
    raw = "";
  }
  if (raw !== snapRaw) {
    snapRaw = raw;
    snap = read();
  }
  return snap;
}

function write(s: State) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the key only lives in memory for this page */
  }
  window.dispatchEvent(new Event(EVT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}

export function useBurners(): State {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

export function normalizePrivateKey(input: string): Hex {
  const t = input.trim();
  const pk = (t.startsWith("0x") ? t : `0x${t}`).toLowerCase();
  if (!isHex(pk) || pk.length !== 66) throw new Error("A private key is 32 bytes: 64 hex characters, optionally prefixed with 0x.");
  return pk as Hex;
}

/** Add (or relabel) a burner key and make it the active one. Returns its address. */
export function addBurner(input: string, label: string): Address {
  const privateKey = normalizePrivateKey(input);
  const address = privateKeyToAccount(privateKey).address;
  const s = read();
  const rest = s.burners.filter((b) => b.address !== address);
  write({ ...s, burners: [...rest, { address, privateKey, label: label.trim() || "burner", addedAt: Date.now() }], active: address });
  return address;
}

export function setActiveBurner(address: Address) {
  const s = read();
  if (!s.burners.some((b) => b.address === address)) return;
  write({ ...s, active: address });
}

export function removeBurner(address: Address) {
  const s = read();
  const burners = s.burners.filter((b) => b.address !== address);
  write({ burners, active: s.active === address ? (burners[0]?.address ?? null) : s.active, connected: s.connected && burners.length > 0 });
}

export function forgetAllBurners() {
  write(EMPTY);
}

function activeAccount(): PrivateKeyAccount | null {
  const s = read();
  const b = s.burners.find((x) => x.address === s.active);
  return b ? privateKeyToAccount(b.privateKey) : null;
}

function setConnected(connected: boolean) {
  const s = read();
  if (s.connected !== connected) write({ ...s, connected });
}

export const BURNER_CONNECTOR_ID = "burner";

export function burner() {
  return createConnector<{ request: EIP1193RequestFn }>((config) => {
    let chainId = config.chains[0].id;
    let account: PrivateKeyAccount | null = null;
    let unsubscribe: (() => void) | null = null;

    const chainFor = (id?: number) => config.chains.find((c) => c.id === (id ?? chainId)) ?? config.chains[0];
    const rpcFor = (id?: number) => (id === undefined || id === config.chains[0].id ? RPC_URL : chainFor(id).rpcUrls.default.http[0]) || RPC_URL;
    const requireAccount = () => {
      if (!account) throw new Error("Burner wallet is not connected");
      return account;
    };
    const walletClient = (id?: number) => createWalletClient({ account: requireAccount(), chain: chainFor(id), transport: http(rpcFor(id)) });

    // Switching the active burner (or removing it) while connected re-points the connection.
    const watch = () => {
      if (typeof window === "undefined" || unsubscribe) return;
      unsubscribe = subscribe(() => {
        if (!account) return;
        const next = activeAccount();
        if (!next) {
          account = null;
          config.emitter.emit("disconnect");
        } else if (next.address !== account.address) {
          account = next;
          config.emitter.emit("change", { accounts: [next.address] });
        }
      });
    };

    return {
      id: BURNER_CONNECTOR_ID,
      name: "Burner key",
      type: "burner",
      async setup() {
        watch();
      },
      async connect({ chainId: want } = {}) {
        const acct = activeAccount();
        if (!acct) throw new Error("Add a burner private key first.");
        account = acct;
        if (want && config.chains.some((c) => c.id === want)) chainId = want;
        setConnected(true);
        watch();
        return { accounts: [acct.address] as never, chainId };
      },
      async disconnect() {
        account = null;
        setConnected(false);
      },
      async getAccounts() {
        if (!account) account = read().connected ? activeAccount() : null;
        return account ? [account.address] : [];
      },
      async getChainId() {
        return chainId;
      },
      async isAuthorized() {
        return read().connected && !!activeAccount();
      },
      async switchChain({ chainId: id }) {
        const c = config.chains.find((x) => x.id === id);
        if (!c) throw new SwitchChainError(new Error(`chain ${id} is not configured`));
        chainId = id;
        config.emitter.emit("change", { chainId: id });
        return c;
      },
      async getClient({ chainId: id } = {}) {
        return walletClient(id);
      },
      async getProvider() {
        // Minimal EIP-1193 surface for code that talks to the provider directly. Signing happens
        // here with the local key; everything else goes to the configured RPC.
        const request: EIP1193RequestFn = (async ({ method, params }: { method: string; params?: unknown }) => {
          const p = (params ?? []) as unknown[];
          switch (method) {
            case "eth_chainId":
              return numberToHex(chainId);
            case "eth_accounts":
            case "eth_requestAccounts":
              return account ? [account.address] : [];
            case "personal_sign":
              return requireAccount().signMessage({ message: { raw: p[0] as Hex } });
            case "eth_signTypedData_v4":
              return requireAccount().signTypedData(JSON.parse(p[1] as string));
            case "eth_sendTransaction": {
              const tx = p[0] as Record<string, Hex | undefined>;
              const big = (v?: Hex) => (v === undefined ? undefined : fromHex(v, "bigint"));
              return walletClient().sendTransaction({ to: tx.to ? getAddress(tx.to) : undefined, data: tx.data, value: big(tx.value), gas: big(tx.gas) } as never);
            }
            case "wallet_switchEthereumChain": {
              const id = Number(fromHex((p[0] as { chainId: Hex }).chainId, "number"));
              if (!config.chains.some((c) => c.id === id)) throw new SwitchChainError(new Error(`chain ${id} is not configured`));
              chainId = id;
              return null;
            }
            default: {
              const res = await fetch(rpcFor(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: p }) });
              const j = (await res.json()) as { result?: unknown; error?: { message: string } };
              if (j.error) throw new Error(j.error.message);
              return j.result;
            }
          }
        }) as EIP1193RequestFn;
        return { request };
      },
      onAccountsChanged(accounts) {
        if (accounts.length === 0) this.onDisconnect();
        else config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) });
      },
      onChainChanged(id) {
        config.emitter.emit("change", { chainId: Number(id) });
      },
      onDisconnect() {
        account = null;
        config.emitter.emit("disconnect");
      },
    };
  });
}

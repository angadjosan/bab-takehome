"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { EncKey } from "./crypto";

/**
 * Buyer X25519 encryption keys, kept in this browser's localStorage. They are separate from
 * the wallet: the public half goes on-chain with `buy`, the secret half unwraps the delivered
 * bundle key. Losing the secret key means losing access to the purchase, so the UI pushes the
 * user to download a backup.
 */

const KEY = "envmarket.encKeys.v1";
const EVT = "envmarket-keys-changed";

function readAll(): EncKey[] {
  if (typeof window === "undefined") return [];
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

let snapshot: EncKey[] = [];
let snapshotRaw = "";
function getSnapshot(): EncKey[] {
  let raw = "";
  try {
    raw = window.localStorage.getItem(KEY) || "[]";
  } catch {
    raw = "[]";
  }
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = readAll();
  }
  return snapshot;
}
const EMPTY: EncKey[] = [];

function subscribe(cb: () => void) {
  const h = () => cb();
  window.addEventListener("storage", h);
  window.addEventListener(EVT, h);
  return () => {
    window.removeEventListener("storage", h);
    window.removeEventListener(EVT, h);
  };
}

function writeAll(keys: EncKey[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(keys));
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new Event(EVT));
}

export function useEncKeys() {
  const keys = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const add = useCallback((k: EncKey) => {
    const all = readAll().filter((x) => x.publicKey.toLowerCase() !== k.publicKey.toLowerCase());
    writeAll([k, ...all]);
  }, []);
  const remove = useCallback((pk: string) => {
    writeAll(readAll().filter((x) => x.publicKey.toLowerCase() !== pk.toLowerCase()));
  }, []);
  const find = useCallback((pk?: string | null) => (pk ? keys.find((k) => k.publicKey.toLowerCase() === pk.toLowerCase()) : undefined), [keys]);
  return { keys, add, remove, find };
}

export function downloadKey(k: EncKey) {
  const body = JSON.stringify(
    {
      type: "envmarket.buyer-encryption-key.v1",
      curve: "X25519",
      publicKey: k.publicKey,
      secretKey: k.secretKey,
      createdAt: new Date(k.createdAt).toISOString(),
      warning: "Anyone with secretKey can decrypt environments delivered to this public key. Keep it private.",
    },
    null,
    2,
  );
  downloadBytes(new TextEncoder().encode(body), `envmarket-key-${k.publicKey.slice(2, 10)}.json`, "application/json");
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = "application/octet-stream") {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

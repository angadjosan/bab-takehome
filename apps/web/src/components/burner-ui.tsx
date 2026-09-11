"use client";

import { useId, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { addBurner, BURNER_CONNECTOR_ID, forgetAllBurners, removeBurner, setActiveBurner, useBurners, type Burner } from "@/lib/burner";
import { CHAIN_ID, IS_MAINNET } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { cx, IconAlert, IconX } from "./ui";

const ROLES = ["seller", "buyer", "buyer2", "juror1", "juror2", "juror3", "observer"];

function useBurnerConnect() {
  const { connector, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const c = connectors.find((x) => x.id === BURNER_CONNECTOR_ID);
  return async () => {
    if (!c) throw new Error("burner connector missing");
    if (isConnected && connector?.id === BURNER_CONNECTOR_ID) return; // the connector follows the active key
    if (isConnected) await disconnectAsync();
    await connectAsync({ connector: c, chainId: CHAIN_ID });
  };
}

/** Paste a throwaway private key; it is kept in sessionStorage for this tab only. */
export function BurnerForm({ onDone }: { onDone?: () => void }) {
  const [pk, setPk] = useState("");
  const [label, setLabel] = useState("buyer");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = useBurnerConnect();
  const id = useId();
  return (
    <div className="space-y-2 text-xs">
      <div className="flex gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2">
        <IconAlert className="mt-px h-4 w-4 shrink-0 text-warn" />
        <p className="leading-relaxed text-ink/85">
          <span className="font-semibold text-warn">Throwaway wallets with tiny balances only.</span> The key is pasted into this page, kept in this tab’s sessionStorage until the tab closes, and signs
          transactions without asking.{IS_MAINNET && " This is Base mainnet: real funds."}
        </p>
      </div>
      <label htmlFor={`${id}-pk`} className="sr-only">
        Private key
      </label>
      <input
        id={`${id}-pk`}
        name="burner-private-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="input font-mono"
        placeholder="Private key, 0x followed by 64 hex characters…"
        value={pk}
        onChange={(e) => setPk(e.target.value)}
      />
      <div className="flex gap-2">
        <label htmlFor={`${id}-label`} className="sr-only">
          Label for this key
        </label>
        <input
          id={`${id}-label`}
          name="burner-label"
          list={`${id}-roles`}
          autoComplete="off"
          spellCheck={false}
          className="input"
          placeholder="Label, e.g. buyer…"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <datalist id={`${id}-roles`}>
          {ROLES.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <button
          className="btn btn-primary btn-sm h-9 shrink-0"
          disabled={!pk || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              addBurner(pk, label);
              setPk("");
              await connect();
              onDone?.();
            } catch (e) {
              setErr((e as Error).message.split("\n")[0]);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Adding…" : "Add and use"}
        </button>
      </div>
      {err && (
        <p role="alert" className="text-bad">
          {err} Check that the key is 0x followed by 64 hex characters.
        </p>
      )}
    </div>
  );
}

/** Keys added this session; click one to act as it. */
export function BurnerSwitcher({ onSwitch }: { onSwitch?: () => void }) {
  const { burners, active } = useBurners();
  const { address, connector } = useAccount();
  const connect = useBurnerConnect();
  const [err, setErr] = useState<string | null>(null);
  if (!burners.length) return null;
  const onBurner = connector?.id === BURNER_CONNECTOR_ID;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1 text-[11px] text-muted">
        <span>Burner keys in this tab</span>
        <button
          type="button"
          className="cursor-pointer rounded px-1 transition-colors duration-150 hover:text-bad"
          onClick={() => {
            if (confirm("Remove every burner key from this tab?")) forgetAllBurners();
          }}
        >
          Forget all
        </button>
      </div>
      <ul className="space-y-1">
        {burners.map((b: Burner) => {
          const current = onBurner && b.address === address;
          return (
            <li key={b.address} className={cx("flex items-center gap-1 rounded-md border px-1 text-xs", current ? "border-accent/40 bg-accent-soft" : "border-line")}>
              <button
                type="button"
                aria-pressed={current}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-left"
                onClick={async () => {
                  setErr(null);
                  try {
                    setActiveBurner(b.address);
                    await connect();
                    onSwitch?.();
                  } catch (e) {
                    setErr((e as Error).message.split("\n")[0]);
                  }
                }}
              >
                <span className="w-16 shrink-0 truncate font-medium text-ink">{b.label}</span>
                <span className="truncate font-mono text-muted" translate="no">
                  {shortAddr(b.address)}
                </span>
                {current ? <span className="badge badge-accent ml-auto">active</span> : b.address === active && !onBurner ? <span className="ml-auto text-muted">selected</span> : null}
              </button>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-bad"
                aria-label={`Remove burner key ${b.label}`}
                title="Remove this key from the tab"
                onClick={() => {
                  if (confirm(`Remove the burner key “${b.label}” from this tab?`)) removeBurner(b.address);
                }}
              >
                <IconX className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {err && (
        <p role="alert" className="px-1 text-xs text-bad">
          {err}
        </p>
      )}
    </div>
  );
}

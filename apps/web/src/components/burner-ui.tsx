"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { addBurner, BURNER_CONNECTOR_ID, forgetAllBurners, removeBurner, setActiveBurner, useBurners, type Burner } from "@/lib/burner";
import { CHAIN_ID, IS_MAINNET } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { cx } from "./ui";

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
  return (
    <div className="space-y-2 text-xs">
      <div className="rounded-lg bg-warn-soft px-3 py-2 text-warn">
        <span className="font-semibold">Only for throwaway wallets with tiny balances.</span> The key is pasted into this page, kept in this tab’s sessionStorage (cleared when the tab closes)
        and signs transactions here without a confirmation prompt.{IS_MAINNET && " This is Base mainnet: real funds."}
      </div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="input font-mono text-xs"
        placeholder="0x… private key (64 hex)"
        value={pk}
        onChange={(e) => setPk(e.target.value)}
      />
      <div className="flex gap-2">
        <input list="burner-roles" className="input text-xs" placeholder="label, e.g. buyer" value={label} onChange={(e) => setLabel(e.target.value)} />
        <datalist id="burner-roles">
          {ROLES.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <button
          className="btn btn-primary btn-sm shrink-0"
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
          Add & use
        </button>
      </div>
      {err && <p className="text-bad">{err}</p>}
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
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1 text-[11px] text-muted">
        <span>Burner keys this session</span>
        <button className="hover:text-bad" onClick={() => forgetAllBurners()} title="Remove every burner key from this tab">
          forget all
        </button>
      </div>
      <ul className="space-y-1">
        {burners.map((b: Burner) => {
          const current = onBurner && b.address === address;
          return (
            <li key={b.address} className={cx("flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs", current ? "border-accent bg-accent-soft" : "border-line")}>
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
                <span className="w-16 shrink-0 truncate font-medium">{b.label}</span>
                <span className="font-mono text-muted">{shortAddr(b.address)}</span>
                {current ? <span className="badge badge-accent ml-auto">active</span> : b.address === active && !onBurner ? <span className="ml-auto text-muted">selected</span> : null}
              </button>
              <button className="text-muted hover:text-bad" title="Remove this key from the tab" onClick={() => removeBurner(b.address)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {err && <p className="px-1 text-xs text-bad">{err}</p>}
    </div>
  );
}

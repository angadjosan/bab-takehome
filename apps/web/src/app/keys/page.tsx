"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, CopyButton, Notice } from "@/components/ui";
import { encKeyFromSecret, eqHash, generateEncKey } from "@/lib/crypto";
import { downloadKey, useEncKeys } from "@/lib/keys";
import { useMarketEvents } from "@/lib/market";

export default function KeysPage() {
  const { keys, add, remove } = useEncKeys();
  const events = useMarketEvents();
  const [imp, setImp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const usage = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of events.data ?? []) {
      if (e.eventName !== "Purchased") continue;
      const pk = String(e.args.buyerEncPubKey).toLowerCase();
      m.set(pk, [...(m.get(pk) ?? []), String(e.args.purchaseId)]);
    }
    return m;
  }, [events.data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Buyer encryption keys</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Purchases are delivered to an X25519 public key you choose at checkout, not to your wallet. The TEE relay wraps the bundle key to it; only the matching secret key can unwrap it.
          Keys live in this browser’s localStorage and nowhere else.
        </p>
      </div>
      <Notice tone="warn" title="Back up your secret keys">
        Clearing site data, switching browsers, or private windows lose them. Anyone who has a secret key can decrypt the environments delivered to it. Download a backup and keep it private.
      </Notice>

      <Card
        title={`${keys.length} key${keys.length === 1 ? "" : "s"} in this browser`}
        action={
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              const k = generateEncKey();
              add(k);
              downloadKey(k);
            }}
          >
            Generate & download
          </button>
        }
      >
        {keys.length === 0 ? (
          <p className="text-sm text-muted">
            No keys yet. One is created for you during checkout on any{" "}
            <Link href="/" className="link">
              listing
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {keys.map((k) => {
              const used = usage.get(k.publicKey.toLowerCase()) ?? [];
              return (
                <li key={k.publicKey} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 font-mono text-xs">
                      <span className="break-all">{k.publicKey}</span>
                      <CopyButton value={k.publicKey} label="public key" />
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      created {new Date(k.createdAt).toLocaleString()} {k.label ? `· ${k.label}` : ""} ·{" "}
                      {used.length ? (
                        <>
                          used by{" "}
                          {used.map((pid, i) => (
                            <span key={pid}>
                              {i > 0 && ", "}
                              <Link href={`/purchase/${pid}`} className="link">
                                purchase #{pid}
                              </Link>
                            </span>
                          ))}
                        </>
                      ) : (
                        "not used by any purchase yet"
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn btn-sm" onClick={() => downloadKey(k)}>
                      Download
                    </button>
                    <button
                      className="btn btn-sm text-bad"
                      onClick={() => {
                        if (confirm(used.length ? "This key decrypts existing purchases. Delete it from this browser anyway? Make sure you have a backup." : "Delete this key from this browser?")) remove(k.publicKey);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Import a secret key" subtitle="Paste the 32-byte secretKey from a key file (0x-prefixed hex). The public key is derived locally.">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="input font-mono text-xs" placeholder="0x…" value={imp} onChange={(e) => setImp(e.target.value)} />
          <button
            className="btn"
            disabled={!imp}
            onClick={() => {
              try {
                const k = encKeyFromSecret(imp);
                if (keys.some((x) => eqHash(x.publicKey, k.publicKey))) throw new Error("That key is already stored.");
                add(k);
                setImp("");
                setErr(null);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Import
          </button>
        </div>
        {err && <p className="mt-2 text-xs text-bad">{err}</p>}
      </Card>
    </div>
  );
}

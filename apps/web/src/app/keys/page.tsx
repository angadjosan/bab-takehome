"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyButton, Notice, PageHeader } from "@/components/ui";
import { eqHash } from "@/lib/crypto";
import { fmtTime, shortHash } from "@/lib/format";
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

  async function doImport() {
    try {
      const { encKeyFromSecret } = await import("@/lib/crypto-heavy");
      const k = encKeyFromSecret(imp);
      if (keys.some((x) => eqHash(x.publicKey, k.publicKey))) throw new Error("That key is already saved in this browser.");
      add(k);
      setImp("");
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Delivery keys"
        actions={
          <button
            className="btn btn-primary"
            onClick={async () => {
              const { generateEncKey } = await import("@/lib/crypto-heavy");
              const k = generateEncKey();
              add(k);
              downloadKey(k);
            }}
          >
            Generate and download
          </button>
        }
      >
        A delivery key is the key your purchases are encrypted to. It is separate from your wallet. The secret half is saved in this browser and nowhere else.
      </PageHeader>

      <Notice tone="warn" title="Keep a backup of each key file">
        Clearing site data, switching browsers or using a private window deletes the keys saved here. Anyone with a key file can open the environments delivered to it.
      </Notice>

      <section aria-labelledby="keys-title" className="space-y-3">
        <h2 id="keys-title" className="text-sm font-semibold text-ink">
          Saved in this browser <span className="ml-1 font-mono font-normal text-muted tabular-nums">{keys.length}</span>
        </h2>
        {keys.length === 0 ? (
          <p className="text-sm text-muted">
            No keys yet. One is created for you when you buy from any{" "}
            <Link href="/" className="link">
              listing
            </Link>
            .
          </p>
        ) : (
          <ul className="card divide-y divide-line">
            {keys.map((k) => {
              const used = usage.get(k.publicKey.toLowerCase()) ?? [];
              return (
                <li key={k.publicKey} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-1 text-sm text-ink">
                      <span className="font-mono" translate="no" title={k.publicKey}>
                        {shortHash(k.publicKey, 10)}
                      </span>
                      <CopyButton value={k.publicKey} label="public key" />
                      {k.label && <span className="text-xs text-muted">· {k.label}</span>}
                    </div>
                    <div className="text-xs text-muted">
                      Created {fmtTime(Math.floor(k.createdAt / 1000))} ·{" "}
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
                      className="btn btn-sm btn-ghost text-bad hover:text-bad"
                      onClick={() => {
                        if (confirm(used.length ? "This key opens existing purchases. Delete it from this browser anyway? Make sure you have a backup first." : "Delete this key from this browser?"))
                          remove(k.publicKey);
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
      </section>

      <section aria-labelledby="import-title" className="space-y-3">
        <h2 id="import-title" className="text-sm font-semibold text-ink">
          Import a key file
        </h2>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            doImport();
          }}
        >
          <label htmlFor="import-secret" className="block text-xs text-muted">
            Secret key from a downloaded key file. The public key is worked out in this browser.
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="import-secret"
              name="secretKey"
              autoComplete="off"
              spellCheck={false}
              className="input font-mono"
              placeholder="0x followed by 64 hex characters…"
              value={imp}
              aria-invalid={!!err}
              aria-describedby={err ? "import-error" : undefined}
              onChange={(e) => setImp(e.target.value)}
            />
            <button type="submit" className="btn shrink-0" disabled={!imp}>
              Import key
            </button>
          </div>
          {err && (
            <p id="import-error" role="alert" className="text-xs text-bad">
              {err}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { useTokenInfo } from "@/components/providers";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import { AddressLink, Card, Countdown, Empty, HashValue, Notice, Skeleton, Spinner, Stars, Verified, cx, useNow, IconCheck, IconX, TxLink } from "@/components/ui";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment, CHAIN_ID } from "@/lib/config";
import { decryptBundle, encKeyFromSecret, eqHash, listTar, sha256Hex, unwrapBundleKey, utf8, type TarEntry } from "@/lib/crypto";
import { describe, useDoc } from "@/lib/docs";
import { fmtTime, fmtUsdc, fmtWindow, maskToIndexes, pct, popcount } from "@/lib/format";
import { downloadBytes, useEncKeys } from "@/lib/keys";
import {
  GROUND_HELP,
  GROUND_LABEL,
  disputeQuote,
  eventsForPurchase,
  useBlockTimes,
  useClaimable,
  useDispute,
  useMarketEvents,
  usePurchase,
  useVersion,
  type Purchase,
  type Version,
} from "@/lib/market";
import { fetchUrlBytes, getDelivery, putBlob, saveLocalEvidence, uploadEvidence } from "@/lib/tee";
import type { MarketEvent } from "@/lib/client";

function parseId(id: string): bigint | null {
  return /^\d+$/.test(id) && id.length < 30 ? BigInt(id) : null;
}

export function PurchaseView({ id }: { id: string }) {
  return (
    <DeploymentGate>
      <Inner id={parseId(id)} raw={id} />
    </DeploymentGate>
  );
}

function Inner({ id, raw }: { id: bigint | null; raw: string }) {
  const p = usePurchase(id);
  const v = useVersion(p.data?.versionId ?? null);
  if (id === null) return <Empty title={`“${raw}” is not a purchase id`} />;
  if (p.isLoading || (p.data && v.isLoading))
    return (
      <div className="space-y-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
      </div>
    );
  if (p.error || !p.data) return <Empty title={`Purchase #${raw} not found`}>{(p.error as Error)?.message}</Empty>;
  if (!v.data) return <Empty title="Version not found">{(v.error as Error)?.message}</Empty>;
  return <PurchaseBody p={p.data} v={v.data} />;
}

function PurchaseBody({ p, v }: { p: Purchase; v: Version }) {
  const { address } = useAccount();
  const events = useMarketEvents();
  const mine = useMemo(() => (events.data ? eventsForPurchase(events.data, p.id) : []), [events.data, p.id]);
  const desc = useDoc(v.uri, v.descriptionHash);
  const d = describe(desc.data?.json);
  const isBuyer = !!address && address.toLowerCase() === p.buyer.toLowerCase();
  const isSeller = !!address && address.toLowerCase() === p.seller.toLowerCase();
  const [tar, setTar] = useState<TarEntry[] | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/listing/${v.id}`} className="text-xs text-muted hover:text-ink">
          ← {d.title ?? `Version #${v.id}`}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Purchase #{p.id.toString()}</h1>
          <StateBadge state={p.state} />
          {isBuyer && <span className="badge badge-accent">you are the buyer</span>}
          {isSeller && <span className="badge badge-accent">you are the seller</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          <span>
            Buyer <AddressLink address={p.buyer} seller />
          </span>
          <span>
            Seller <AddressLink address={p.seller} seller />
          </span>
          <span>Price {fmtUsdc(p.price)}</span>
        </div>
      </div>

      <ClaimBanner />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Timeline p={p} events={mine} />
          <NextActions p={p} v={v} isBuyer={isBuyer} tar={tar} />
          {p.deliveredAt > 0 && <DeliveryCard p={p} v={v} isBuyer={isBuyer} onTar={setTar} />}
        </div>
        <aside className="space-y-6">
          <TermsSnapshot p={p} />
          {(p.state === "Settled" || p.state === "Refunded") && <SettlementCard p={p} />}
          <Card title="On-chain history" subtitle="Every event touching this purchase.">
            {events.isLoading ? <Skeleton className="h-24" /> : <EventList events={[...mine].reverse()} compact />}
          </Card>
        </aside>
      </div>
    </div>
  );
}

export function StateBadge({ state }: { state: string }) {
  const tone = { Funded: "badge-info", Delivered: "badge-accent", Disputed: "badge-warn", Refunded: "badge-neutral", Settled: "badge-ok" }[state] ?? "badge-neutral";
  return <span className={cx("badge", tone)}>{state}</span>;
}

export function ClaimBanner() {
  const { address } = useAccount();
  const c = useClaimable(address);
  const w = useTx();
  if (!address || !c.data || c.data === 0n || !deployment) return null;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 border-warn/40 bg-warn-soft px-5 py-3">
      <div className="text-sm">
        <span className="font-semibold text-warn">{fmtUsdc(c.data)} is waiting for you in the market.</span>{" "}
        <span className="text-muted">Refunds, returned bonds, seller proceeds and juror rewards are credited here (pull payments) and must be withdrawn.</span>
        <TxStatus state={w.state} />
      </div>
      <button className="btn btn-primary btn-sm" disabled={w.busy} onClick={() => w.run("Withdraw", { address: deployment!.market, abi: marketAbi, functionName: "withdraw" })}>
        Withdraw
      </button>
    </div>
  );
}

/* --------------------------------- timeline --------------------------------- */

function Timeline({ p, events }: { p: Purchase; events: MarketEvent[] }) {
  const now = useNow();
  const find = (n: string) => events.find((e) => e.eventName === n);
  const dispute = useDispute(p.disputeId > 0n ? p.disputeId : null);
  const times = useBlockTimes(events.map((e) => e.blockNumber));
  const disputeEv = find("DisputeOpened");

  type S = { key: string; label: string; state: "done" | "active" | "todo" | "skipped"; at?: number; tx?: string; body: ReactNode };
  const steps: S[] = [
    {
      key: "funded",
      label: "Funded",
      state: "done",
      at: p.fundedAt,
      tx: find("Purchased")?.transactionHash,
      body: `${fmtUsdc(p.price)} escrowed in the contract; ${fmtUsdc(p.collateral)} of seller collateral reserved for this purchase.`,
    },
  ];
  if (p.state === "Refunded" && p.deliveredAt === 0) {
    steps.push({ key: "undelivered", label: "Not delivered in time", state: "done", at: p.deliveryDeadline, body: "The relay did not record a delivery receipt before the deadline." });
    steps.push({ key: "refunded", label: "Refunded", state: "done", at: p.settledAt, tx: find("RefundedUndelivered")?.transactionHash, body: `Full price (${fmtUsdc(p.price)}) credited back to the buyer; collateral released.` });
  } else {
    steps.push({
      key: "delivered",
      label: "Key delivered",
      state: p.deliveredAt ? "done" : "active",
      at: p.deliveredAt || undefined,
      tx: find("Delivered")?.transactionHash,
      body: p.deliveredAt ? (
        "The TEE relay wrapped the bundle key to the buyer’s encryption key and its signed receipt was verified on-chain. The challenge clock started."
      ) : (
        <>
          Waiting for the TEE relay to deliver. Deadline {fmtTime(p.deliveryDeadline)} (<Countdown to={p.deliveryDeadline} doneText="passed: full refund available" />
          ).
        </>
      ),
    });
    if (p.disputeId > 0n) {
      steps.push({
        key: "disputed",
        label: `Disputed (#${p.disputeId})`,
        state: p.state === "Disputed" ? "active" : "done",
        at: dispute.data?.openedAt ?? (disputeEv ? times.data?.get(disputeEv.blockNumber) : undefined),
        tx: disputeEv?.transactionHash,
        body: (
          <>
            {GROUND_LABEL[dispute.data?.ground ?? 0] ?? "Dispute"} filed before the deadline; normal finalization is frozen.{" "}
            <Link href={`/dispute/${p.disputeId}`} className="link">
              Open the dispute →
            </Link>
          </>
        ),
      });
    } else if (p.deliveredAt) {
      const open = now <= p.challengeDeadline;
      steps.push({
        key: "window",
        label: "Challenge window",
        state: p.state === "Settled" ? "done" : open ? "active" : "done",
        at: p.challengeDeadline,
        body: open ? (
          <>
            The buyer can dispute specific tasks until {fmtTime(p.challengeDeadline)} (<Countdown to={p.challengeDeadline} /> left).
          </>
        ) : (
          "Closed without a dispute."
        ),
      });
    }
    steps.push({
      key: "settled",
      label: "Settled",
      state: p.state === "Settled" ? "done" : "todo",
      at: p.settledAt || undefined,
      tx: find("PurchaseSettled")?.transactionHash,
      body:
        p.state === "Settled"
          ? `Seller proceeds ${fmtUsdc(p.sellerProceeds)}, refund ${fmtUsdc(p.refunded)}, marketplace fee ${fmtUsdc(p.fee)}.`
          : p.state === "Disputed"
            ? "Settles when the dispute resolves."
            : "After the challenge window, anyone can call finalize() to pay the seller.",
    });
  }

  return (
    <Card title="Status">
      <ol className="relative space-y-5">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex gap-4">
            {i < steps.length - 1 && <span className="absolute left-[9px] top-6 h-[calc(100%+0.25rem)] w-px bg-line" />}
            <span
              className={cx(
                "relative z-10 mt-0.5 flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border-2",
                s.state === "done" && "border-ok bg-ok text-white",
                s.state === "active" && "border-accent bg-panel",
                s.state === "todo" && "border-line-strong bg-panel",
              )}
            >
              {s.state === "done" ? <IconCheck className="h-3 w-3" /> : s.state === "active" ? <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className={cx("text-sm font-semibold", s.state === "todo" && "text-muted")}>{s.label}</span>
                {s.at ? <span className="text-xs text-muted">{fmtTime(s.at)}</span> : null}
                {s.tx && <TxLink hash={s.tx} />}
              </div>
              <div className="mt-0.5 text-sm text-muted">{s.body}</div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ------------------------------- next actions ------------------------------- */

function NextActions({ p, v, isBuyer, tar }: { p: Purchase; v: Version; isBuyer: boolean; tar: TarEntry[] | null }) {
  const now = useNow();
  const finalize = useTx();
  const refund = useTx();
  const m = deployment!.market;

  if (p.state === "Funded") {
    const late = now > p.deliveryDeadline;
    return (
      <Card title={late ? "Delivery deadline passed" : "Waiting for key delivery"}>
        {late ? (
          <>
            <p className="text-sm text-muted">
              No delivery receipt was recorded by {fmtTime(p.deliveryDeadline)}. Anyone can now return the full {fmtUsdc(p.price)} to the buyer and release the seller’s collateral.
            </p>
            <RequireWallet why="Connect any wallet to trigger the refund. You don’t need to be the buyer.">
              <button className="btn btn-primary mt-3" disabled={refund.busy} onClick={() => refund.run("Refund", { address: m, abi: marketAbi, functionName: "refundUndelivered", args: [p.id] })}>
                Refund undelivered purchase
              </button>
            </RequireWallet>
            <TxStatus state={refund.state} />
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> The TEE relay watches for new purchases and records delivery automatically. If it does not deliver within <Countdown to={p.deliveryDeadline} />, a full refund
            becomes available here.
          </p>
        )}
      </Card>
    );
  }

  if (p.state === "Delivered") {
    const open = now <= p.challengeDeadline;
    return (
      <>
        {!open && (
          <Card title="Challenge window closed">
            <p className="text-sm text-muted">
              No dispute was filed. Contracts don’t act on their own: anyone can now call <code className="font-mono">finalize()</code> to release {fmtUsdc(p.price - (p.price * BigInt(p.feeBps)) / 10000n)} to the seller (price minus the {pct(p.feeBps)} fee) and
              update reputation.
            </p>
            <RequireWallet why="Connect any wallet to finalize. It is permissionless.">
              <button className="btn btn-primary mt-3" disabled={finalize.busy} onClick={() => finalize.run("Finalize", { address: m, abi: marketAbi, functionName: "finalize", args: [p.id] })}>
                Finalize purchase
              </button>
            </RequireWallet>
            <TxStatus state={finalize.state} />
          </Card>
        )}
        {open && (
          <Card
            title="Challenge window open"
            subtitle={
              <>
                <Countdown to={p.challengeDeadline} /> left to dispute · closes {fmtTime(p.challengeDeadline)}
              </>
            }
          >
            {isBuyer ? (
              <DisputeForm p={p} v={v} tar={tar} />
            ) : (
              <p className="text-sm text-muted">Only the buyer can open a dispute. If none is filed, anyone can finalize after the deadline.</p>
            )}
          </Card>
        )}
      </>
    );
  }

  if (p.state === "Settled" && p.deliveredAt > 0) {
    return <RateCard p={p} isBuyer={isBuyer} />;
  }
  return null;
}

/* ------------------------------ delivery & decrypt ------------------------------ */

type Check = { label: string; ok: boolean | null; detail?: ReactNode };

function DeliveryCard({ p, v, isBuyer, onTar }: { p: Purchase; v: Version; isBuyer: boolean; onTar: (t: TarEntry[]) => void }) {
  return (
    <Card title="Delivery receipt" subtitle="Recorded on-chain by the relay; signature over (purchaseId, buyerEncPubKey, ciphertextHash, wrappedKeyHash, wrapperHash) verified by the contract.">
      <dl className="kv">
        <dt>Relay (signer)</dt>
        <dd>
          <AddressLink address={p.relay} />
        </dd>
        <dt>Delivered at</dt>
        <dd>{fmtTime(p.deliveredAt)}</dd>
        <dt>Buyer encryption key</dt>
        <dd>
          <HashValue value={p.buyerEncPubKey} />
        </dd>
        <dt>ciphertextHash</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <HashValue value={p.ciphertextHash} />
          <Verified ok={eqHash(p.ciphertextHash, v.ciphertextHash)} okText="= version commitment" badText="≠ version" />
        </dd>
        <dt>wrappedKeyHash</dt>
        <dd>
          <HashValue value={p.wrappedKeyHash} />
        </dd>
        <dt>wrapperHash</dt>
        <dd>
          <HashValue value={p.wrapperHash} />
        </dd>
      </dl>
      <p className="mt-3 text-xs text-muted">A receipt records that delivery happened; it does not prove the key works. If it doesn’t, dispute under “Doesn’t match hash / broken”.</p>
      {isBuyer && (
        <div className="mt-5 border-t border-line pt-5">
          <Decrypt p={p} v={v} onTar={onTar} />
        </div>
      )}
    </Card>
  );
}

function Decrypt({ p, v, onTar }: { p: Purchase; v: Version; onTar: (t: TarEntry[]) => void }) {
  const { find, add } = useEncKeys();
  const key = find(p.buyerEncPubKey);
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [plain, setPlain] = useState<Uint8Array | null>(null);
  const [entries, setEntries] = useState<TarEntry[] | null>(null);
  const [imp, setImp] = useState("");
  const [impErr, setImpErr] = useState<string | null>(null);

  async function run() {
    if (!key) return;
    setRunning(true);
    setPlain(null);
    const list: Check[] = [];
    const push = (c: Check) => {
      list.push(c);
      setChecks([...list]);
      return c.ok;
    };
    try {
      const dl = await getDelivery(p.id);
      const wh = sha256Hex(dl.wrapperBytes);
      push({ label: "Delivery wrapper hash matches on-chain wrapperHash", ok: eqHash(wh, p.wrapperHash), detail: <HashValue value={wh} /> });
      const w = dl.wrapper as Record<string, unknown>;
      const fieldsOk =
        String(w.purchaseId) === p.id.toString() &&
        Number(w.chainId) === CHAIN_ID &&
        eqHash(String(w.market), deployment!.market) &&
        eqHash(String(w.buyer), p.buyer) &&
        eqHash(String(w.buyerEncPubKey), p.buyerEncPubKey) &&
        eqHash(String(w.bundleHash), v.bundleHash) &&
        eqHash(String(w.ciphertextHash), v.ciphertextHash);
      push({ label: "Wrapper names this purchase, chain, market, buyer, key and bundle", ok: fieldsOk, detail: <span className="font-mono">{w.type as string} · issued {fmtTime(Number(w.issuedAt))}</span> });
      const kh = sha256Hex(dl.wrappedKey);
      push({ label: "Wrapped key hash matches on-chain wrappedKeyHash", ok: eqHash(kh, p.wrappedKeyHash), detail: <HashValue value={kh} /> });
      const ct = await fetchUrlBytes(dl.ciphertextUrl);
      const ch = sha256Hex(ct);
      push({ label: `Ciphertext (${(ct.length / 1024).toFixed(1)} KiB) hash matches ciphertextHash`, ok: eqHash(ch, v.ciphertextHash), detail: <HashValue value={ch} /> });
      let bundleKey: Uint8Array;
      try {
        bundleKey = unwrapBundleKey(dl.wrappedKey, key.secretKey, p.wrapperHash);
        push({ label: "Unwrapped bundle key with your X25519 secret key (ECIES, HKDF salt = wrapperHash)", ok: true });
      } catch (e) {
        push({ label: "Unwrap bundle key", ok: false, detail: (e as Error).message });
        return;
      }
      let pt: Uint8Array;
      try {
        pt = decryptBundle(ct, bundleKey);
        push({ label: "Decrypted bundle (AES-256-GCM, authenticated)", ok: true });
      } catch (e) {
        push({ label: "Decrypt bundle", ok: false, detail: (e as Error).message });
        return;
      }
      const bh = sha256Hex(pt);
      push({ label: "sha256(plaintext tar) equals the listing’s bundleHash", ok: eqHash(bh, v.bundleHash), detail: <HashValue value={bh} /> });
      const ents = listTar(pt);
      setEntries(ents);
      onTar(ents);
      setPlain(pt);
    } catch (e) {
      push({ label: "Fetch delivery from the TEE service", ok: false, detail: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }

  const tasks = entries ? [...new Set(entries.filter((e) => e.path.startsWith("tasks/")).map((e) => e.path.split("/")[1]).filter(Boolean))] : [];
  const hasAudit = entries?.some((e) => /audit/i.test(e.path));

  return (
    <div>
      <h3 className="text-sm font-semibold">Download & decrypt</h3>
      <p className="mt-1 text-xs text-muted">Everything below runs in your browser. The key never leaves this page; the service only hands out the buyer-encrypted key blob.</p>
      {!key ? (
        <div className="mt-3 space-y-2">
          <Notice tone="warn" title="Your secret key for this purchase isn’t in this browser">
            The purchase was made for public key <span className="break-all font-mono">{p.buyerEncPubKey}</span>. Paste the matching secret key (from your downloaded key file) to decrypt.
          </Notice>
          <div className="flex gap-2">
            <input className="input font-mono text-xs" placeholder="0x… secretKey" value={imp} onChange={(e) => setImp(e.target.value)} />
            <button
              className="btn btn-sm"
              onClick={() => {
                try {
                  const k = encKeyFromSecret(imp);
                  if (!eqHash(k.publicKey, p.buyerEncPubKey)) throw new Error("That secret key does not match this purchase’s public key.");
                  add(k);
                  setImpErr(null);
                } catch (e) {
                  setImpErr((e as Error).message);
                }
              }}
            >
              Import
            </button>
          </div>
          {impErr && <p className="text-xs text-bad">{impErr}</p>}
        </div>
      ) : (
        <button className="btn btn-primary mt-3" disabled={running} onClick={run}>
          {running ? <Spinner /> : null} {checks.length ? "Run again" : "Download, verify & decrypt"}
        </button>
      )}
      {checks.length > 0 && (
        <ul className="mt-4 space-y-2">
          {checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full", c.ok ? "bg-ok text-white" : "bg-bad text-white")}>
                {c.ok ? <IconCheck className="h-3 w-3" /> : <IconX className="h-3 w-3" />}
              </span>
              <div className="min-w-0">
                <div>{c.label}</div>
                {c.detail && <div className="text-xs text-muted">{c.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {plain && entries && (
        <div className="mt-4 rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-semibold">Canonical bundle</span> · {entries.filter((e) => e.type === "file").length} files · {(plain.length / 1024).toFixed(1)} KiB · {tasks.length} task folder(s)
              {hasAudit ? " · contains audit paths!" : " · no audit tasks (as committed)"}
            </div>
            <button className="btn btn-sm" onClick={() => downloadBytes(plain, `envmarket-purchase-${p.id}-${v.bundleHash.slice(2, 10)}.tar`, "application/x-tar")}>
              Save .tar
            </button>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-accent">Show file list</summary>
            <ul className="mt-2 max-h-64 overflow-auto font-mono text-[11px] text-muted">
              {entries.map((e) => (
                <li key={e.path}>
                  {e.path} {e.type === "file" ? <span className="text-faint">({e.size} B)</span> : null}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- dispute ---------------------------------- */

function DisputeForm({ p, v, tar }: { p: Purchase; v: Version; tar: TarEntry[] | null }) {
  const router = useRouter();
  const { address } = useAccount();
  const token = useTokenInfo();
  const [ground, setGround] = useState<number>(0);
  const [mask, setMask] = useState<bigint>(0n);
  const [evidence, setEvidence] = useState("");
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [claimSel, setClaimSel] = useState<string[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const approve = useTx();
  const open = useTx();
  const desc = useDoc(v.uri, v.descriptionHash);
  const claims = describe(desc.data?.json).claims;
  const m = deployment!.market;

  const selected = popcount(mask);
  const q = disputeQuote(p.price, p.taskCount, selected, p);
  // For "Description is false" the TEE's case packet picks disputed claims out of the evidence by id
  // (C1, C2, …), so selected claims are written into the text that gets hashed.
  const evidenceText = ground === 2 && claimSel.length ? `Disputed claims: ${claimSel.join(", ")}\n\n${evidence.trim()}` : evidence.trim();
  const evidenceBytes = file ? file.bytes : evidenceText ? utf8(evidenceText) : null;
  const evidenceHash = evidenceBytes ? sha256Hex(evidenceBytes) : (`0x${"0".repeat(64)}` as Hex);
  const allowance = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "allowance", args: [address!, m], query: { enabled: !!address, refetchInterval: 8_000 } });
  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { enabled: !!address, refetchInterval: 8_000 } });
  const approved = ((allowance.data as bigint | undefined) ?? 0n) >= q.bond;
  const enough = ((bal.data as bigint | undefined) ?? 0n) >= q.bond;
  const taskIds = tar ? [...new Set(tar.filter((e) => e.path.startsWith("tasks/")).map((e) => e.path.split("/")[1]).filter(Boolean))].sort() : [];
  const ready = ground > 0 && selected > 0 && !!evidenceBytes && (ground !== 2 || claimSel.length > 0 || !!file || /\bC[1-9][0-9]*\b/.test(evidenceText));

  /** Evidence goes to the TEE first (it returns sha256 of the stored bytes); that hash goes on-chain. */
  async function submit() {
    if (!evidenceBytes) return;
    setUploadErr(null);
    setStage("Uploading evidence privately to the TEE…");
    let hash: Hex;
    try {
      hash = (await uploadEvidence(file ? { bytes: file.bytes } : { text: evidenceText })).evidenceHash;
    } catch (e) {
      setStage(null);
      setUploadErr(`Evidence upload failed, dispute not opened: ${(e as Error).message}`);
      return;
    }
    setStage(`The TEE stored your evidence (sha256 ${hash.slice(0, 14)}…). Opening the dispute on-chain…`);
    const r = await open.run("Open dispute", { address: m, abi: marketAbi, functionName: "openDispute", args: [p.id, ground, mask, hash] });
    setStage(null);
    if (!r) return;
    const logs = parseEventLogs({ abi: marketAbi, logs: r.logs, eventName: "DisputeOpened" as never });
    const did = (logs[0] as { args?: { disputeId?: bigint } } | undefined)?.args?.disputeId;
    if (did === undefined) return;
    if (!file) saveLocalEvidence(did, evidenceText);
    router.push(`/dispute/${did}`);
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        File a specific, bonded claim. Only three grounds qualify; poor training results alone do not, and reward hacking is out of scope. Each task can be remedied once, and total post-delivery refunds are capped at{" "}
        {pct(p.refundCapBps)} of the price.
      </p>

      <fieldset>
        <legend className="section-title">1 · Ground</legend>
        <div className="mt-2 space-y-2">
          {[1, 2, 3].map((g) => (
            <label key={g} className={cx("flex cursor-pointer gap-3 rounded-lg border p-3 text-sm", ground === g ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}>
              <input type="radio" name="ground" className="mt-1" checked={ground === g} onChange={() => setGround(g)} />
              <span>
                <span className="font-medium">{GROUND_LABEL[g]}</span>
                <span className="mt-0.5 block text-xs text-muted">{GROUND_HELP[g]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="section-title">2 · Affected tasks</legend>
        <p className="mt-1 text-xs text-muted">Task i is bit i of the on-chain task mask. {taskIds.length === p.taskCount ? "Folder names come from your decrypted bundle (sorted)." : ""}</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: p.taskCount }, (_, i) => {
            const bit = 1n << BigInt(i);
            const on = (mask & bit) !== 0n;
            const remedied = (p.remediedMask & bit) !== 0n;
            return (
              <label key={i} className={cx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", on ? "border-accent bg-accent-soft" : "border-line")}>
                <input type="checkbox" checked={on} disabled={remedied} onChange={() => setMask((x) => x ^ bit)} />
                <span className="min-w-0">
                  <span className="font-medium">Task {i + 1}</span>
                  {taskIds.length === p.taskCount && <span className="block truncate font-mono text-[11px] text-muted">{taskIds[i]}</span>}
                  {remedied && <span className="block text-[11px] text-muted">already remedied</span>}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="section-title">3 · Evidence</legend>
        {ground === 2 && claims.length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-muted">Which numbered claim(s) are false? Jurors receive exactly these claims from the frozen description.</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {claims.map((c) => {
                const on = claimSel.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    title={c.text}
                    className={cx("badge cursor-pointer", on ? "badge-accent" : "badge-neutral")}
                    onClick={() => setClaimSel((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                  >
                    {c.id}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {!file && (
          <textarea
            className="input mt-2 min-h-28 font-mono text-xs"
            placeholder={ground === 2 ? "e.g. C3 says every task runs offline, but task 2’s tests call pypi.org at import time (see tests/test_fetch.py)." : "Describe what you observed and how to reproduce it."}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label className="btn btn-sm cursor-pointer">
            {file ? "Replace file" : "…or attach a file instead"}
            <input
              type="file"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 256 * 1024) {
                  setUploadErr("Evidence files are limited to 256 KiB by the TEE.");
                  return;
                }
                setUploadErr(null);
                setFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
              }}
            />
          </label>
          {file && (
            <>
              <span className="font-mono">
                {file.name} ({(file.bytes.length / 1024).toFixed(1)} KiB)
              </span>
              <button type="button" className="text-muted hover:text-bad" onClick={() => setFile(null)}>
                remove
              </button>
            </>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            evidenceHash = sha256({file ? "file bytes" : "text"}): <HashValue value={evidenceHash} />
          </span>
          <span>Before the dispute opens, the evidence is stored privately by the TEE (for the reviewers’ case packet); only its hash goes on-chain. Text evidence is also kept in this browser.</span>
        </div>
      </fieldset>

      <div className="rounded-lg bg-panel-2 p-4 text-sm">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniVal label="Tasks selected" value={`${selected} × ${fmtUsdc(q.perTask, { symbol: false })}`} />
          <MiniVal label="Requested refund" value={fmtUsdc(q.requested)} hint={q.requested === q.cap && selected > 0 ? "at the refund cap" : undefined} />
          <MiniVal label="Your bond" value={fmtUsdc(q.bond)} hint={`clamped to ${fmtUsdc(p.bondFloor, { symbol: false })}–${fmtUsdc(p.bondCap, { symbol: false })}`} />
          <MiniVal label="Case fee (loser pays)" value={fmtUsdc(p.caseFee)} />
        </div>
        <p className="mt-3 text-xs text-muted">
          If you win, you get the refund plus your full bond back and the seller’s collateral pays the case fee. If you lose, the case fee comes out of your bond and the rest goes to a neutral reserve (never to the seller).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!approved ? (
          <button className="btn" disabled={!ready || !enough || approve.busy} onClick={() => approve.run("Approve bond", { address: deployment!.token, abi: tokenAbi, functionName: "approve", args: [m, q.bond] })}>
            Approve {fmtUsdc(q.bond)} bond
          </button>
        ) : (
          <span className="badge badge-ok">bond approved</span>
        )}
        <button className="btn btn-primary" disabled={!ready || !approved || open.busy} onClick={submit}>
          Open dispute
        </button>
        {!enough && selected > 0 && <span className="text-xs text-warn">You need {fmtUsdc(q.bond)} {token.symbol} for the bond.</span>}
      </div>
      <TxStatus state={approve.state} />
      <TxStatus state={open.state} />
      {stage && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" /> {stage}
        </p>
      )}
      {uploadErr && <p className="break-words text-xs text-bad">{uploadErr}</p>}
    </div>
  );
}

function MiniVal({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div>
      <div className="section-title">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

/* ---------------------------------- rating ---------------------------------- */

function RateCard({ p, isBuyer }: { p: Purchase; isBuyer: boolean }) {
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const tx = useTx();
  if (p.rated)
    return (
      <Card title="Buyer rating">
        <div className="flex items-center gap-2">
          <Stars value={p.stars} />
          <span className="text-sm text-muted">{p.stars}/5 · counted once in this version’s rating and, weighted by the {fmtUsdc(p.price - p.refunded)} the seller retained, in the seller’s score.</span>
        </div>
      </Card>
    );
  if (!isBuyer)
    return (
      <Card title="Buyer rating">
        <p className="text-sm text-muted">Not rated yet. Only the buyer of a delivered, settled purchase can rate, once.</p>
      </Card>
    );
  const commentHash = comment.trim() ? sha256Hex(comment) : (`0x${"0".repeat(64)}` as Hex);
  return (
    <Card title="Rate this environment" subtitle="One rating per purchase. It feeds this version’s average and the seller’s money-weighted score.">
      <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} className={cx("text-2xl leading-none", (hover || stars) >= i ? "text-warn" : "text-line-strong")} onMouseEnter={() => setHover(i)} onClick={() => setStars(i)} aria-label={`${i} stars`}>
            ★
          </button>
        ))}
        <span className="ml-2 text-sm text-muted">{stars ? `${stars}/5` : "choose"}</span>
      </div>
      <textarea className="input mt-3 min-h-20 text-sm" placeholder="Optional comment (published by hash)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="mt-1 text-xs text-muted">
        commentHash: <HashValue value={commentHash} />
      </div>
      <RequireWallet>
        <button
          className="btn btn-primary mt-3"
          disabled={!stars || tx.busy}
          onClick={async () => {
            // publish the comment text by hash (best effort; the rating stands without it)
            if (comment.trim()) await putBlob(utf8(comment)).catch(() => undefined);
            await tx.run("Rate", { address: deployment!.market, abi: marketAbi, functionName: "rate", args: [p.id, stars, commentHash] });
          }}
        >
          Submit rating
        </button>
      </RequireWallet>
      <TxStatus state={tx.state} />
    </Card>
  );
}

/* ------------------------------ side cards ------------------------------ */

function TermsSnapshot({ p }: { p: Purchase }) {
  return (
    <Card title="Frozen terms" subtitle="Snapshotted when the purchase was funded.">
      <dl className="kv text-[13px]">
        <dt>Price</dt>
        <dd>{fmtUsdc(p.price)}</dd>
        <dt>Per task</dt>
        <dd>
          {fmtUsdc(p.taskCount ? p.price / BigInt(p.taskCount) : 0n)} × {p.taskCount}
        </dd>
        <dt>Collateral</dt>
        <dd>{fmtUsdc(p.collateral)}</dd>
        <dt>Challenge window</dt>
        <dd>{fmtWindow(p.challengeWindow)}</dd>
        <dt>Delivery deadline</dt>
        <dd>{fmtTime(p.deliveryDeadline)}</dd>
        {p.challengeDeadline > 0 && (
          <>
            <dt>Challenge deadline</dt>
            <dd>{fmtTime(p.challengeDeadline)}</dd>
          </>
        )}
        <dt>Refund cap</dt>
        <dd>
          {pct(p.refundCapBps)} ({fmtUsdc((p.price * BigInt(p.refundCapBps)) / 10000n)})
        </dd>
        <dt>Bond</dt>
        <dd>
          {fmtUsdc(p.bondFloor, { symbol: false })}–{fmtUsdc(p.bondCap)}
        </dd>
        <dt>Case fee</dt>
        <dd>{fmtUsdc(p.caseFee)}</dd>
        <dt>Fee</dt>
        <dd>{pct(p.feeBps)} of retained</dd>
        <dt>Penalty</dt>
        <dd>
          {pct(p.penaltyBps)} of price if &gt; {pct(p.penaltyThresholdBps)} of tasks confirmed defective
        </dd>
        {p.remediedMask > 0n && (
          <>
            <dt>Remedied tasks</dt>
            <dd>{maskToIndexes(p.remediedMask).map((i) => i + 1).join(", ")}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function SettlementCard({ p }: { p: Purchase }) {
  const rows: [string, bigint, string][] =
    p.state === "Refunded"
      ? [["Refunded to buyer", p.refunded, "full price, pre-delivery timeout"]]
      : [
          ["Refund to buyer", p.refunded, "confirmed defective tasks × per-task price, capped"],
          ["Seller proceeds", p.sellerProceeds, "retained − fee"],
          ["Marketplace fee", p.fee, "to treasury"],
          ["Penalties", p.penalties, "slashed from collateral → neutral reserve"],
        ];
  return (
    <Card title="Settlement" subtitle={`Settled ${fmtTime(p.settledAt)}. Amounts are credited as claimable and withdrawn by each party.`}>
      <dl className="space-y-2 text-sm">
        {rows.map(([k, val, hint]) => (
          <div key={k} className="flex items-start justify-between gap-3">
            <dt>
              {k}
              <div className="text-[11px] text-muted">{hint}</div>
            </dt>
            <dd className="font-semibold tabular-nums">{fmtUsdc(val)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { EventList } from "@/components/events";
import { useTokenInfo, useWalletMode } from "@/components/providers";
import { RequireWallet, TxStatus, useTx } from "@/components/tx";
import { useApproveAndCall } from "@/components/tx-sequence";
import {
  AddressLink,
  Chip,
  Countdown,
  DetailSection,
  Details,
  Empty,
  HashValue,
  IconArrowRight,
  IconCheck,
  IconX,
  PageHeader,
  PurchaseStateChip,
  Skeleton,
  Spinner,
  Stars,
  Verified,
  cx,
  useNow,
} from "@/components/ui";
import { marketAbi, tokenAbi } from "@/lib/abi";
import { deployment, CHAIN_ID } from "@/lib/config";
import { eqHash, listTar, sha256Hex, utf8, type TarEntry } from "@/lib/crypto";
import { describe, useDoc, useHealth, useProtocol } from "@/lib/docs";
import { wakeJurors } from "@/lib/jurors";
import { fmtKiB, fmtTime, fmtUsdc, fmtWindow, maskToIndexes, pct, popcount, shortAddr } from "@/lib/format";
import { downloadBytes, useEncKeys } from "@/lib/keys";
import { useWalletEncKey } from "@/lib/enc-derive";
import {
  GROUND_LABEL,
  isMechanical,
  useIsVerifier,
  useMarketConstants,
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
import { useDisputeQuote } from "@/lib/reads-purchase";
import { fetchUrlBytes, getDelivery, putBlob, saveLocalEvidence, uploadEvidence } from "@/lib/tee";
import type { MarketEvent } from "@/lib/client";

function parseId(id: string): bigint | null {
  return /^\d+$/.test(id) && id.length < 30 ? BigInt(id) : null;
}

/**
 * Who decides a dispute ground, from the contract: FalseDescription goes to a jury of SEATS jurors; the
 * other grounds need a finding signed by an isVerifier address. The verifier is named when the TEE's
 * /health signer holds that role; the re-run tolerance for PreviewNotReproducible comes from TEE GET /protocol.
 */
function GroundHelp({ g }: { g: number }) {
  const consts = useMarketConstants();
  const health = useHealth();
  const verifier = useIsVerifier(health.data?.signer);
  const protocol = useProtocol();
  if (!isMechanical(g)) return <>Decided by {consts.data ? `${consts.data.seats} ` : ""}staked jurors.</>;
  const signer = verifier.data === true ? health.data?.signer : undefined;
  const rep = g === 3 ? protocol.data?.spec?.reproducibility : undefined;
  const llmTol = typeof rep?.llmRerunTolerancePp === "number" ? rep.llmRerunTolerancePp : undefined;
  const detTol = typeof rep?.deterministicRegradeTolerance === "number" ? rep.deterministicRegradeTolerance : undefined;
  return (
    <>
      Decided by a finding signed by {signer ? <span title={signer}>the TEE signer {shortAddr(signer)}</span> : "an address with the contract’s verifier role"}.
      {llmTol !== undefined && ` Re-run tolerance: ${llmTol} percentage points per model.`}
      {detTol !== undefined && ` Regrade tolerance: ${detTol}.`}
    </>
  );
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
  const back = (
    <Link href="/" className="btn btn-sm">
      Browse environments
    </Link>
  );
  if (id === null)
    return (
      <Empty title={`“${raw}” isn’t a purchase number`} action={back}>
        Purchase numbers are whole numbers, like /purchase/12.
      </Empty>
    );
  if (p.isLoading || (p.data && v.isLoading))
    return (
      <div className="mx-auto max-w-3xl space-y-8" aria-busy="true" aria-label="Loading purchase…">
        <div className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-8 w-80 max-w-full" />
        </div>
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </div>
    );
  if (p.error || !p.data)
    return (
      <Empty title={`Purchase #${raw} not found`} action={back}>
        {(p.error as Error)?.message?.split("\n")[0] ?? "There’s no purchase with this number on this market."}
      </Empty>
    );
  if (!v.data)
    return (
      <Empty title="The environment for this purchase couldn’t be loaded" action={back}>
        {(v.error as Error)?.message?.split("\n")[0] ?? "Reload the page to try again."}
      </Empty>
    );
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
  const dl = useDownload(p, v, isBuyer && p.deliveredAt > 0);
  const title = d.title ?? `Environment #${v.id}`;
  // "Report a problem" is reachable from the header and from My purchases (/purchase/:id#report).
  // This view only mounts client-side after the purchase loads, so reading the hash here is safe.
  const [reporting, setReporting] = useState(() => typeof window !== "undefined" && window.location.hash === "#report");
  const scrollToReport = () => requestAnimationFrame(() => document.getElementById("report-problem")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  useEffect(() => {
    if (reporting || window.location.hash === "#rate") scrollToReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival from a deep link
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        back={{ href: `/listing/${v.id}`, label: title }}
        eyebrow={`Purchase #${p.id.toString()}`}
        title={title}
        actions={
          isBuyer ? (
            <ReportShortcut
              p={p}
              onClick={() => {
                setReporting(true);
                scrollToReport();
              }}
            />
          ) : undefined
        }
        meta={
          <>
            <PurchaseStateChip state={p.state} long />
            {isBuyer && <Chip tone="accent">You bought this</Chip>}
            {isSeller && <Chip tone="accent">You sold this</Chip>}
            <span>
              Price <span className="font-mono text-ink tabular-nums">{fmtUsdc(p.price)}</span>
            </span>
          </>
        }
      />

      <ClaimBanner />

      <Tracker p={p} events={mine} />

      <NextAction p={p} v={v} isBuyer={isBuyer} dl={dl} reporting={reporting} setReporting={setReporting} />

      <PurchaseDetails p={p} v={v} dl={dl} events={mine} eventsLoading={events.isLoading} />
    </div>
  );
}

/** Header button while the buyer can still report a problem, with the time left. */
function ReportShortcut({ p, onClick }: { p: Purchase; onClick: () => void }) {
  const now = useNow();
  if (p.state !== "Delivered" || !p.deliveredAt || now > p.challengeDeadline) return null;
  return (
    <button className="btn btn-sm" onClick={onClick}>
      Report a problem
      <span className="text-xs font-normal text-muted">
        · <Countdown to={p.challengeDeadline} /> left
      </span>
    </button>
  );
}

export function StateBadge({ state }: { state: string }) {
  return <PurchaseStateChip state={state} />;
}

export function ClaimBanner() {
  const { address } = useAccount();
  const c = useClaimable(address);
  const w = useTx();
  if (!address || !c.data || c.data === 0n || !deployment) return null;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 text-sm">
        <div className="font-medium text-ink">
          You have <span className="font-mono tabular-nums">{fmtUsdc(c.data)}</span> to withdraw
        </div>
        <div aria-live="polite">
          <TxStatus state={w.state} />
        </div>
      </div>
      <button className="btn btn-primary btn-sm" disabled={w.busy} onClick={() => w.run("Withdraw", { address: deployment!.market, abi: marketAbi, functionName: "withdraw" })}>
        {w.busy ? "Withdrawing…" : "Withdraw"}
      </button>
    </div>
  );
}

/* --------------------------------- progress --------------------------------- */

type StepState = "done" | "active" | "todo";
type Step = { key: string; label: string; state: StepState; sub?: ReactNode };

function Tracker({ p, events }: { p: Purchase; events: MarketEvent[] }) {
  const now = useNow();
  const dispute = useDispute(p.disputeId > 0n ? p.disputeId : null);
  const times = useBlockTimes(events.map((e) => e.blockNumber));
  const disputeEv = events.find((e) => e.eventName === "DisputeOpened");
  const at = (t?: number) => (t ? fmtTime(t) : undefined);

  const steps: Step[] = [{ key: "paid", label: "Paid", state: "done", sub: at(p.fundedAt) }];
  if (p.state === "Refunded" && p.deliveredAt === 0) {
    steps.push({ key: "undelivered", label: "Not delivered", state: "done", sub: at(p.deliveryDeadline) });
    steps.push({ key: "refunded", label: "Refunded", state: "done", sub: at(p.settledAt) });
  } else {
    steps.push({
      key: "delivered",
      label: "Delivered",
      state: p.deliveredAt ? "done" : "active",
      sub: p.deliveredAt ? (
        at(p.deliveredAt)
      ) : (
        <>
          Due in <Countdown to={p.deliveryDeadline} doneText="overdue" />
        </>
      ),
    });
    if (p.disputeId > 0n) {
      const openedAt = dispute.data?.openedAt ?? (disputeEv ? times.data?.get(disputeEv.blockNumber) : undefined);
      steps.push({ key: "reported", label: "Problem reported", state: p.state === "Disputed" ? "active" : "done", sub: at(openedAt) });
      steps.push({ key: "decided", label: "Decided", state: p.state === "Settled" ? "done" : "todo", sub: p.state === "Settled" ? at(p.settledAt) : "Under review" });
    } else {
      const open = !!p.deliveredAt && now <= p.challengeDeadline;
      steps.push({
        key: "window",
        label: "Protection window",
        state: !p.deliveredAt ? "todo" : p.state === "Settled" || !open ? "done" : "active",
        sub: !p.deliveredAt ? (
          `${fmtWindow(p.challengeWindow)} after delivery`
        ) : open ? (
          <>
            Ends in <Countdown to={p.challengeDeadline} />
          </>
        ) : (
          `Ended ${fmtTime(p.challengeDeadline)}`
        ),
      });
      steps.push({ key: "complete", label: "Complete", state: p.state === "Settled" ? "done" : "todo", sub: p.state === "Settled" ? at(p.settledAt) : undefined });
    }
  }

  return (
    <ol aria-label="Purchase progress" className={cx("grid gap-4 sm:gap-3", steps.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4")}>
      {steps.map((s) => (
        <li
          key={s.key}
          aria-current={s.state === "active" ? "step" : undefined}
          className={cx(
            "min-w-0 border-l-2 pl-3 sm:border-t-2 sm:border-l-0 sm:pt-3 sm:pl-0",
            s.state === "done" ? "border-ok" : s.state === "active" ? "border-accent" : "border-line-strong",
          )}
        >
          <div className={cx("flex items-center gap-1.5 text-sm font-medium", s.state === "todo" ? "text-muted" : "text-ink")}>
            {s.state === "done" && <IconCheck className="h-3.5 w-3.5 shrink-0 text-ok" />}
            {s.label}
            <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "active" ? " (in progress)" : " (not yet)"}</span>
          </div>
          {s.sub && <div className="mt-0.5 text-xs text-muted tabular-nums">{s.sub}</div>}
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------ download & decrypt ------------------------------ */

type Check = { label: string; ok: boolean | null; detail?: ReactNode };
type Download = ReturnType<typeof useDownload>;

/**
 * Delivered purchase → decrypted environment, with no key handling for the buyer: the decryption key
 * is the one derived from the buyer's wallet at purchase time (cached in this browser, or re-derived
 * with one signature). Once it is available, download + verify + decrypt runs automatically; the page
 * then offers one "Download environment" button. Lifted to page level so the action panel and the
 * details panel share the same checks.
 */
function useDownload(p: Purchase, v: Version, enabled: boolean) {
  const { find, add } = useEncKeys();
  const { derive } = useWalletEncKey();
  const key = find(p.buyerEncPubKey);
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [plain, setPlain] = useState<Uint8Array | null>(null);
  const [entries, setEntries] = useState<TarEntry[] | null>(null);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const autoRan = useRef(false);

  useEffect(() => {
    if (!enabled || !key || autoRan.current) return;
    autoRan.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decrypt once, when this purchase's key becomes available
  }, [key, enabled]);

  async function unlock() {
    setUnlockErr(null);
    setUnlocking(true);
    try {
      const k = await derive({ fresh: true });
      if (!eqHash(k.publicKey, p.buyerEncPubKey))
        setUnlockErr("This wallet’s key doesn’t match the one this purchase was made for. Sign in with the wallet that bought it, or open this page in the browser you bought it from.");
    } catch (e) {
      setUnlockErr((e as Error).message.split("\n")[0]);
    } finally {
      setUnlocking(false);
    }
  }

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
      // HPKE + AES-GCM are only downloaded when someone actually decrypts
      const [dl, { unwrapBundleKeyAsync, decryptBundle }] = await Promise.all([getDelivery(p.id), import("@/lib/crypto-heavy")]);
      const wh = sha256Hex(dl.wrapperBytes);
      push({ label: "Delivery wrapper hash matches the on-chain wrapperHash", ok: eqHash(wh, p.wrapperHash), detail: <HashValue value={wh} /> });
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
      push({ label: "Wrapped key hash matches the on-chain wrappedKeyHash", ok: eqHash(kh, p.wrappedKeyHash), detail: <HashValue value={kh} /> });
      const ct = await fetchUrlBytes(dl.ciphertextUrl);
      const ch = sha256Hex(ct);
      push({ label: `Encrypted file (${fmtKiB(ct.length)}) matches the ciphertextHash`, ok: eqHash(ch, v.ciphertextHash), detail: <HashValue value={ch} /> });
      let bundleKey: Uint8Array;
      try {
        bundleKey = await unwrapBundleKeyAsync(dl.wrappedKey, key.secretKey, p.wrapperHash);
        push({ label: "Unwrapped the bundle key with your X25519 secret key (HPKE, aad = wrapperHash)", ok: true });
      } catch (e) {
        push({ label: "Unwrap the bundle key", ok: false, detail: (e as Error).message });
        return;
      }
      let pt: Uint8Array;
      try {
        pt = decryptBundle(ct, bundleKey);
        push({ label: "Decrypted the bundle (AES-256-GCM, authenticated)", ok: true });
      } catch (e) {
        push({ label: "Decrypt the bundle", ok: false, detail: (e as Error).message });
        return;
      }
      const bh = sha256Hex(pt);
      push({ label: "sha256 of the decrypted tar equals the listing’s bundleHash", ok: eqHash(bh, v.bundleHash), detail: <HashValue value={bh} /> });
      setEntries(listTar(pt));
      setPlain(pt);
    } catch (e) {
      push({ label: "Fetch the delivery from the TEE service", ok: false, detail: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }

  const save = () => plain && downloadBytes(plain, `envmarket-purchase-${p.id}-${v.bundleHash.slice(2, 10)}.tar`, "application/x-tar");
  const failed = checks.some((c) => !c.ok);
  const passed = checks.filter((c) => c.ok).length;
  return { key, add, checks, running, plain, entries, unlockErr, unlocking, unlock, run, save, failed, passed };
}

function DownloadControl({ p, dl, quiet }: { p: Purchase; dl: Download; quiet?: boolean }) {
  const { devTools } = useWalletMode();
  const [imp, setImp] = useState("");
  const [impErr, setImpErr] = useState<string | null>(null);
  const files = dl.entries?.filter((e) => e.type === "file").length ?? 0;
  const hasAudit = dl.entries?.some((e) => /audit/i.test(e.path));
  const btn = cx("btn", !quiet && "btn-primary");

  if (!dl.key)
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">Unlock the download with the wallet you bought with (one signature, no transaction).</p>
        <button className={btn} disabled={dl.unlocking} onClick={dl.unlock}>
          {dl.unlocking && <Spinner className="h-3.5 w-3.5" />}
          {dl.unlocking ? "Waiting for your signature…" : "Unlock with your wallet"}
        </button>
        {dl.unlockErr && (
          <p role="alert" className="text-xs text-bad">
            {dl.unlockErr}
          </p>
        )}
        {devTools && (
          <details className="rounded-md border border-dashed border-line px-3 py-2 text-xs">
            <summary className="cursor-pointer text-muted">Dev tools: import a secret key</summary>
            <form
              className="mt-2 flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const { encKeyFromSecret } = await import("@/lib/crypto-heavy");
                  const k = encKeyFromSecret(imp);
                  if (!eqHash(k.publicKey, p.buyerEncPubKey)) throw new Error("That secret key belongs to a different purchase.");
                  dl.add(k);
                  setImpErr(null);
                } catch (err) {
                  setImpErr((err as Error).message);
                }
              }}
            >
              <input
                aria-label="Secret key"
                name="secretKey"
                autoComplete="off"
                spellCheck={false}
                className="input font-mono text-xs"
                placeholder="0x…"
                value={imp}
                onChange={(e) => setImp(e.target.value)}
              />
              <button type="submit" className="btn btn-sm shrink-0" disabled={!imp}>
                Import
              </button>
            </form>
            {impErr && <p className="mt-1 text-bad">{impErr}</p>}
          </details>
        )}
      </div>
    );

  return (
    <div className="space-y-2" aria-live="polite">
      {dl.running ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="h-4 w-4" /> Preparing your download…
        </p>
      ) : dl.failed ? (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-[13px] text-bad">
            <IconX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>The download didn’t pass its checks. The failing step is listed under Verification details below; if the file doesn’t match the listing, report a problem.</span>
          </p>
          <button className="btn btn-sm" onClick={dl.run}>
            Try again
          </button>
        </div>
      ) : dl.plain ? (
        <>
          <button className={btn} onClick={dl.save}>
            Download environment
          </button>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <IconCheck className="h-3.5 w-3.5 shrink-0 text-ok" />
            <span>
              <span className="tabular-nums">{files}</span> files · <span className="tabular-nums">{fmtKiB(dl.plain?.length ?? 0)}</span> · matches the listing
              {hasAudit ? <span className="text-warn"> · contains audit paths</span> : null}
            </span>
          </p>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------- the one action ------------------------------- */

function Panel({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="card card-pad space-y-4" aria-labelledby="next-action-title">
      <h2 id="next-action-title" className="text-base font-semibold text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function NextAction({ p, v, isBuyer, dl, reporting, setReporting }: { p: Purchase; v: Version; isBuyer: boolean; dl: Download; reporting: boolean; setReporting: (x: boolean) => void }) {
  const now = useNow();
  const finalize = useTx();
  const refund = useTx();
  const dispute = useDispute(p.disputeId > 0n ? p.disputeId : null);
  const m = deployment!.market;

  if (p.state === "Funded") {
    if (now <= p.deliveryDeadline)
      return (
        <Panel title="Waiting for the seller’s key">
          <p className="flex items-start gap-2 text-sm text-muted" aria-live="polite">
            <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Delivery deadline in <Countdown to={p.deliveryDeadline} />. After that, <span className="font-mono text-ink tabular-nums">{fmtUsdc(p.price)}</span> can be refunded to the buyer.
            </span>
          </p>
        </Panel>
      );
    return (
      <Panel title="The key never arrived">
        <p className="text-sm text-muted">
          No key was delivered by {fmtTime(p.deliveryDeadline)}. <span className="font-mono text-ink tabular-nums">{fmtUsdc(p.price)}</span> can be refunded to the buyer.
        </p>
        <RequireWallet why="Sign in to send the refund.">
          <button className="btn btn-primary" disabled={refund.busy} onClick={() => refund.run("Refund", { address: m, abi: marketAbi, functionName: "refundUndelivered", args: [p.id] })}>
            {refund.busy ? "Refunding…" : isBuyer ? "Refund my payment" : "Refund the buyer"}
          </button>
        </RequireWallet>
        <div aria-live="polite">
          <TxStatus state={refund.state} />
        </div>
      </Panel>
    );
  }

  if (p.state === "Delivered") {
    const open = now <= p.challengeDeadline;
    if (!open) {
      const toSeller = p.price - (p.price * BigInt(p.feeBps)) / 10000n;
      return (
        <Panel title="Protection window closed">
          <p className="text-sm text-muted">
            No problem was reported. <span className="font-mono text-ink tabular-nums">{fmtUsdc(toSeller)}</span> can be released to the seller (price minus the {pct(p.feeBps)} marketplace fee).
          </p>
          <RequireWallet why="Sign in to release the payment.">
            <button className="btn btn-primary" disabled={finalize.busy} onClick={() => finalize.run("Release payment", { address: m, abi: marketAbi, functionName: "finalize", args: [p.id] })}>
              {finalize.busy ? "Releasing…" : "Release payment to the seller"}
            </button>
          </RequireWallet>
          <div aria-live="polite">
            <TxStatus state={finalize.state} />
          </div>
          {isBuyer && (
            <div className="border-t border-line pt-4">
              <DownloadControl p={p} dl={dl} quiet />
            </div>
          )}
        </Panel>
      );
    }
    if (!isBuyer)
      return (
        <Panel title="The buyer is checking the environment">
          <p className="text-sm text-muted">
            The buyer can report a problem until {fmtTime(p.challengeDeadline)} (<Countdown to={p.challengeDeadline} /> left).
          </p>
        </Panel>
      );
    return (
      <Panel title="Your environment is ready">
        <p className="text-sm text-muted">
          Download it and check the tasks and tests. You have <Countdown to={p.challengeDeadline} /> to report a problem.
        </p>
        <DownloadControl p={p} dl={dl} />
        <div className="border-t border-line pt-4">
          {!reporting ? (
            <button className="btn btn-sm btn-ghost -ml-2.5" aria-expanded={false} aria-controls="report-problem" onClick={() => setReporting(true)}>
              Report a problem
            </button>
          ) : (
            <div id="report-problem" className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">Report a problem</h3>
                <button className="btn btn-sm btn-ghost" aria-expanded aria-controls="report-problem" onClick={() => setReporting(false)}>
                  Cancel
                </button>
              </div>
              <DisputeForm p={p} v={v} tar={dl.entries} />
            </div>
          )}
        </div>
      </Panel>
    );
  }

  if (p.state === "Disputed")
    return (
      <Panel title="A problem was reported">
        <p className="text-sm text-muted">
          {dispute.data ? `“${GROUND_LABEL[dispute.data.ground] ?? "Dispute"}”` : "The buyer’s report"} is open. No decision yet.
        </p>
        <Link href={`/dispute/${p.disputeId}`} className="btn btn-primary">
          View the report <IconArrowRight className="h-3.5 w-3.5" />
        </Link>
        {isBuyer && (
          <div className="border-t border-line pt-4">
            <DownloadControl p={p} dl={dl} quiet />
          </div>
        )}
      </Panel>
    );

  if (p.state === "Refunded")
    return (
      <Panel title="Refunded">
        <SettlementRows p={p} />
      </Panel>
    );

  if (p.state === "Settled")
    return (
      <Panel title="Complete">
        <SettlementRows p={p} />
        {p.deliveredAt > 0 && (
          <div id="rate">
            <RateBlock p={p} isBuyer={isBuyer} />
          </div>
        )}
        {isBuyer && p.deliveredAt > 0 && (
          <div className="border-t border-line pt-4">
            <DownloadControl p={p} dl={dl} quiet />
          </div>
        )}
      </Panel>
    );
  return null;
}

function SettlementRows({ p }: { p: Purchase }) {
  const rows: [string, bigint][] =
    p.state === "Refunded"
      ? [["Returned to the buyer", p.refunded]]
      : [
          ["Refunded to the buyer", p.refunded],
          ["Paid to the seller", p.sellerProceeds],
          ["Marketplace fee", p.fee],
          ...(p.penalties > 0n ? ([["Seller penalty", p.penalties]] as [string, bigint][]) : []),
        ];
  return (
    <div>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([k, val]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-2 first:pt-0">
            <dt className="text-muted">{k}</dt>
            <dd className="font-mono text-ink tabular-nums">{fmtUsdc(val)}</dd>
          </div>
        ))}
      </dl>
      {p.settledAt > 0 && <p className="mt-2 text-xs text-muted">Settled {fmtTime(p.settledAt)}.</p>}
    </div>
  );
}

/* ---------------------------------- report a problem ---------------------------------- */

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
  const open = useApproveAndCall();
  const desc = useDoc(v.uri, v.descriptionHash);
  const claims = describe(desc.data?.json).claims;
  const m = deployment!.market;

  const selected = popcount(mask);
  // requested refund and bond come from the contract's own quoteDispute view
  const quote = useDisputeQuote(p.id, mask);
  const q = quote.data;
  const perTask = p.taskCount ? p.price / BigInt(p.taskCount) : 0n;
  const atCap = !!q && selected > 0 && q.requested < BigInt(selected) * perTask;
  const exampleClaim = claims[0]?.id;
  // For "Description is false" the TEE's case packet picks disputed claims out of the evidence by id
  // (C1, C2, …), so selected claims are written into the text that gets hashed.
  const evidenceText = ground === 2 && claimSel.length ? `Disputed claims: ${claimSel.join(", ")}\n\n${evidence.trim()}` : evidence.trim();
  const evidenceBytes = file ? file.bytes : evidenceText ? utf8(evidenceText) : null;
  const bal = useReadContract({ address: deployment!.token, abi: tokenAbi, functionName: "balanceOf", args: [address!], query: { enabled: !!address, refetchInterval: 8_000 } });
  const enough = !!q && ((bal.data as bigint | undefined) ?? 0n) >= q.bond;
  const taskIds = tar ? [...new Set(tar.filter((e) => e.path.startsWith("tasks/")).map((e) => e.path.split("/")[1]).filter(Boolean))].sort() : [];
  const ready = ground > 0 && selected > 0 && !!evidenceBytes && (ground !== 2 || claimSel.length > 0 || !!file || /\bC[1-9][0-9]*\b/.test(evidenceText));
  // Inline errors appear after the first failed submit; focus then jumps to the first field that needs attention.
  const [tried, setTried] = useState(false);
  const errs = {
    ground: ground === 0 ? "Choose what’s wrong." : null,
    tasks: selected === 0 ? "Pick at least one task." : null,
    claims: ground === 2 && claims.length > 0 && !claimSel.length && !file && !/\bC[1-9][0-9]*\b/.test(evidenceText) ? `Pick the claim that’s false, or name it${exampleClaim ? ` (e.g. ${exampleClaim})` : ""} in your evidence.` : null,
    evidence: !evidenceBytes ? "Describe what you found, or attach a file." : null,
  };
  function trySubmit() {
    if (ready) return submit();
    setTried(true);
    const form = document.getElementById("report-form");
    const target = errs.ground
      ? form?.querySelector<HTMLElement>('input[name="ground"]')
      : errs.tasks
        ? form?.querySelector<HTMLElement>('input[name="tasks"]:not(:disabled)')
        : errs.claims
          ? form?.querySelector<HTMLElement>("[aria-pressed]")
          : form?.querySelector<HTMLElement>("#dispute-evidence, input[name='evidenceFile']");
    target?.focus();
  }
  const fieldError = (msg: string | null) =>
    tried && msg ? (
      <p role="alert" className="mt-1 text-xs text-bad">
        {msg}
      </p>
    ) : null;

  /** Evidence goes to the TEE first (it returns sha256 of the stored bytes); that hash goes on-chain. */
  async function submit() {
    if (!evidenceBytes || !q) return;
    setUploadErr(null);
    setStage("Sending your evidence privately…");
    let hash: Hex;
    try {
      hash = (await uploadEvidence(file ? { bytes: file.bytes } : { text: evidenceText })).evidenceHash;
    } catch (e) {
      setStage(null);
      setUploadErr(`Your evidence didn’t upload, so nothing was submitted. Try again. (${(e as Error).message})`);
      return;
    }
    setStage("Evidence stored. Submitting your report…");
    const r = await open.run("Report a problem", q.bond, { address: m, abi: marketAbi, functionName: "openDispute", args: [p.id, ground, mask, hash] });
    setStage(null);
    if (!r) return;
    const logs = parseEventLogs({ abi: marketAbi, logs: r.logs, eventName: "DisputeOpened" as never });
    const did = (logs[0] as { args?: { disputeId?: bigint } } | undefined)?.args?.disputeId;
    if (did === undefined) return;
    if (ground === 2) wakeJurors(did); // FalseDescription: start the AI jurors now
    if (!file) saveLocalEvidence(did, evidenceText);
    router.push(`/dispute/${did}`);
  }

  const busyText = stage ? "Submitting…" : open.step === "1/2" ? "Allowing the deposit… (1 of 2)" : open.step === "2/2" ? "Submitting… (2 of 2)" : "Submitting…";

  return (
    <div id="report-form" className="space-y-6">
      <p className="text-sm text-muted">Refunds are per task, up to {pct(p.refundCapBps)} of the price in total.</p>

      <fieldset>
        <legend className="text-sm font-medium text-ink">What’s wrong?</legend>
        {fieldError(errs.ground)}
        <div className="mt-2 space-y-2">
          {[1, 2, 3].map((g) => (
            <label
              key={g}
              className={cx(
                "flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors duration-150",
                ground === g ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
              )}
            >
              <input type="radio" name="ground" className="mt-1 accent-[var(--accent-fill)]" checked={ground === g} onChange={() => setGround(g)} />
              <span className="min-w-0">
                <span className="font-medium text-ink">{GROUND_LABEL[g]}</span>
                <span className="mt-0.5 block text-xs text-muted">
                  <GroundHelp g={g} />
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-ink">Which tasks?</legend>
        {fieldError(errs.tasks)}
        {taskIds.length === p.taskCount && <p className="mt-1 text-xs text-muted">Names come from the files you downloaded.</p>}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: p.taskCount }, (_, i) => {
            const bit = 1n << BigInt(i);
            const on = (mask & bit) !== 0n;
            const remedied = (p.remediedMask & bit) !== 0n;
            return (
              <label
                key={i}
                className={cx(
                  "flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors duration-150",
                  on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
                  remedied && "cursor-not-allowed opacity-60",
                )}
              >
                <input type="checkbox" name="tasks" value={i + 1} className="accent-[var(--accent-fill)]" checked={on} disabled={remedied} onChange={() => setMask((x) => x ^ bit)} />
                <span className="min-w-0">
                  <span className="font-medium text-ink">Task {i + 1}</span>
                  {taskIds.length === p.taskCount && <span className="block truncate font-mono text-[11px] text-muted">{taskIds[i]}</span>}
                  {remedied && <span className="block text-[11px] text-muted">already refunded</span>}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-ink">What did you find?</legend>
        {fieldError(errs.claims ?? errs.evidence)}
        {ground === 2 && claims.length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-muted">Which of the seller’s numbered claims are false?</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {claims.map((c) => {
                const on = claimSel.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    title={c.text}
                    aria-pressed={on}
                    className={cx("badge h-7 cursor-pointer px-2 font-mono", on ? "badge-accent" : "badge-neutral hover:text-ink")}
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
          <>
            <label htmlFor="dispute-evidence" className="sr-only">
              Describe the problem
            </label>
            <textarea
              id="dispute-evidence"
              name="evidence"
              autoComplete="off"
              className="input mt-2 min-h-28 text-sm"
              placeholder={ground === 2 ? "Which claim is false, what you saw instead, and where (file, task)…" : "What you saw, and how someone else can reproduce it…"}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label className="btn btn-sm cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ring)]">
            {file ? "Replace file" : "Attach a file instead"}
            <input
              type="file"
              name="evidenceFile"
              aria-label="Attach an evidence file"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                // size limits are the TEE's; an oversized file is rejected by /evidence-upload with its own message
                setUploadErr(null);
                setFile({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
              }}
            />
          </label>
          {file && (
            <>
              <span className="min-w-0 truncate font-mono text-muted">
                {file.name} ({fmtKiB(file.bytes.length)})
              </span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFile(null)}>
                Remove
              </button>
            </>
          )}
        </div>
      </fieldset>

      <div className="rounded-md bg-panel-2 px-4 py-3">
        <dl className="divide-y divide-line text-sm">
          <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0">
            <dt className="text-muted">
              Refund if you’re right
              <span className="block text-xs">
                {selected} task{selected === 1 ? "" : "s"} × {fmtUsdc(perTask)}
                {atCap ? `, capped at ${pct(p.refundCapBps)}` : ""}
              </span>
            </dt>
            <dd className="font-mono text-ink tabular-nums">{q ? fmtUsdc(q.requested) : "…"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-muted">Deposit</dt>
            <dd className="font-mono text-ink tabular-nums">{q ? fmtUsdc(q.bond) : "…"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2 last:pb-0">
            <dt className="text-muted">Review fee</dt>
            <dd className="font-mono text-ink tabular-nums">{fmtUsdc(p.caseFee)}</dd>
          </div>
        </dl>
        {quote.error && (
          <p role="alert" className="mt-3 text-xs text-bad">
            Couldn’t read the deposit from the contract: {(quote.error as Error).message.split("\n")[0]}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <button className="btn btn-primary" disabled={!enough || open.busy || !!stage} onClick={trySubmit}>
          {(open.busy || stage) && <Spinner className="h-3.5 w-3.5" />}
          {open.busy || stage ? busyText : `Submit report${selected > 0 && q ? ` · ${fmtUsdc(q.bond)} deposit` : ""}`}
        </button>
        {q && !enough && selected > 0 && (
          <p className="text-xs text-warn">
            You need {fmtUsdc(q.bond)} for the deposit.{token.hasFaucet ? ` Get ${token.symbol} from the bar at the top of the page.` : ""}
          </p>
        )}
        <div aria-live="polite" className="space-y-1">
          <TxStatus state={open.state} />
          {stage && <p className="text-xs text-muted">{stage}</p>}
          {uploadErr && (
            <p role="alert" className="text-xs text-bad [overflow-wrap:anywhere]">
              {uploadErr}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- rating ---------------------------------- */

function StarGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-6 w-6" aria-hidden>
      <path
        d="M10 1.8l2.5 5.2 5.7.8-4.1 4 1 5.6L10 14.8l-5.1 2.6 1-5.6-4.1-4 5.7-.8L10 1.8z"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RateBlock({ p, isBuyer }: { p: Purchase; isBuyer: boolean }) {
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const tx = useTx();
  if (p.rated)
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
        <span className="text-muted">{isBuyer ? "You rated this" : "The buyer rated this"}</span>
        <Stars value={p.stars} />
        <span className="font-mono text-ink tabular-nums">{p.stars}/5</span>
      </div>
    );
  if (!isBuyer) return <p className="border-t border-line pt-4 text-sm text-muted">The buyer hasn’t rated this yet.</p>;
  const commentHash = comment.trim() ? sha256Hex(comment) : (`0x${"0".repeat(64)}` as Hex);
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">How was it?</h3>
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Rating" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            className={cx("cursor-pointer rounded p-0.5 transition-colors duration-150", (hover || stars) >= i ? "text-accent" : "text-line-strong hover:text-muted")}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(0)}
            onClick={() => setStars(i)}
            aria-label={`${i} star${i === 1 ? "" : "s"}`}
            aria-pressed={stars === i}
          >
            <StarGlyph on={(hover || stars) >= i} />
          </button>
        ))}
        <span className="ml-2 font-mono text-sm text-muted tabular-nums">{stars ? `${stars}/5` : ""}</span>
      </div>
      <div>
        <label htmlFor="rating-comment" className="mb-1 block text-xs text-muted">
          Comment (optional)
        </label>
        <textarea
          id="rating-comment"
          name="comment"
          autoComplete="off"
          className="input min-h-20 text-sm"
          placeholder="What worked, what didn’t…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      <RequireWallet>
        <button
          className="btn btn-primary"
          disabled={!stars || tx.busy}
          onClick={async () => {
            // publish the comment text by hash (best effort; the rating stands without it)
            if (comment.trim()) await putBlob(utf8(comment)).catch(() => undefined);
            await tx.run("Rate", { address: deployment!.market, abi: marketAbi, functionName: "rate", args: [p.id, stars, commentHash] });
          }}
        >
          {tx.busy ? "Submitting…" : "Submit rating"}
        </button>
      </RequireWallet>
      <div aria-live="polite">
        <TxStatus state={tx.state} />
      </div>
    </div>
  );
}

/* ---------------------------------- details ---------------------------------- */

function PurchaseDetails({ p, v, dl, events, eventsLoading }: { p: Purchase; v: Version; dl: Download; events: MarketEvent[]; eventsLoading: boolean }) {
  const delivered = p.deliveredAt > 0;
  const ctOk = eqHash(p.ciphertextHash, v.ciphertextHash);
  const checksRun = dl.checks.length > 0 && !dl.running;
  const status = dl.running ? "pending" : checksRun ? (dl.failed ? "bad" : "ok") : delivered ? (ctOk ? "ok" : "bad") : "neutral";
  const summary = dl.running
    ? "Verifying in your browser…"
    : checksRun
      ? dl.failed
        ? `${dl.passed} of ${dl.checks.length} checks passed`
        : `Verified in your browser · ${dl.checks.length} checks passed`
      : delivered
        ? ctOk
          ? "Delivery recorded on-chain · receipt signed by the relay"
          : "The delivery receipt doesn’t match the listing"
        : "Purchase recorded on-chain";
  const tasks = dl.entries ? [...new Set(dl.entries.filter((e) => e.path.startsWith("tasks/")).map((e) => e.path.split("/")[1]).filter(Boolean))] : [];

  return (
    <Details summary={<>Verification details · {summary}</>} status={status} defaultOpen={checksRun && dl.failed}>
      {dl.checks.length > 0 && (
        <DetailSection title="Checks run in your browser">
          <ul className="space-y-2">
            {dl.checks.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full", c.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
                  {c.ok ? <IconCheck className="h-3 w-3" /> : <IconX className="h-3 w-3" />}
                </span>
                <div className="min-w-0">
                  <div className="text-ink">{c.label}</div>
                  {c.detail && <div className="text-xs text-muted [overflow-wrap:anywhere]">{c.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {delivered && (
        <DetailSection title="Delivery receipt">
          <dl className="kv">
            <dt>Relay</dt>
            <dd>
              <AddressLink address={p.relay} />
            </dd>
            <dt>Delivered</dt>
            <dd>{fmtTime(p.deliveredAt)}</dd>
            <dt>Buyer encryption key</dt>
            <dd>
              <HashValue value={p.buyerEncPubKey} />
            </dd>
            <dt>ciphertextHash</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <HashValue value={p.ciphertextHash} />
              <Verified ok={ctOk} okText="matches listing" badText="differs from listing" />
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
        </DetailSection>
      )}

      {dl.entries && dl.plain && (
        <DetailSection title="Bundle contents">
          <p className="text-[13px] text-muted">
            <span className="tabular-nums">{dl.entries.filter((e) => e.type === "file").length}</span> files · <span className="tabular-nums">{fmtKiB(dl.plain.length)}</span> ·{" "}
            <span className="tabular-nums">{tasks.length}</span> task folders
          </p>
          <ul className="mt-2 max-h-64 overflow-auto rounded-md bg-panel-2 px-3 py-2 font-mono text-[11px] text-muted">
            {dl.entries.map((e) => (
              <li key={e.path} className="[overflow-wrap:anywhere]">
                {e.path} {e.type === "file" ? <span className="text-faint">({e.size} B)</span> : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      <DetailSection title="Parties">
        <dl className="kv">
          <dt>Buyer</dt>
          <dd>
            <AddressLink address={p.buyer} seller />
          </dd>
          <dt>Seller</dt>
          <dd>
            <AddressLink address={p.seller} seller />
          </dd>
        </dl>
      </DetailSection>

      <DetailSection title="Terms at purchase">
        <dl className="kv">
          <dt>Price</dt>
          <dd className="font-mono tabular-nums">
            {fmtUsdc(p.price)} ({fmtUsdc(p.taskCount ? p.price / BigInt(p.taskCount) : 0n)} × {p.taskCount} tasks)
          </dd>
          <dt>Seller collateral</dt>
          <dd className="font-mono tabular-nums">{fmtUsdc(p.collateral)}</dd>
          <dt>Protection window</dt>
          <dd>{fmtWindow(p.challengeWindow)} after delivery</dd>
          <dt>Delivery deadline</dt>
          <dd>{fmtTime(p.deliveryDeadline)}</dd>
          {p.challengeDeadline > 0 && (
            <>
              <dt>Protection ends</dt>
              <dd>{fmtTime(p.challengeDeadline)}</dd>
            </>
          )}
          <dt>Refund cap</dt>
          <dd className="font-mono tabular-nums">
            {pct(p.refundCapBps)} ({fmtUsdc((p.price * BigInt(p.refundCapBps)) / 10000n)})
          </dd>
          <dt>Deposit to report</dt>
          <dd className="font-mono tabular-nums">
            {fmtUsdc(p.bondFloor, { symbol: false })}–{fmtUsdc(p.bondCap)}
          </dd>
          <dt>Review fee</dt>
          <dd className="font-mono tabular-nums">{fmtUsdc(p.caseFee)}</dd>
          <dt>Marketplace fee</dt>
          <dd>{pct(p.feeBps)}</dd>
          <dt>Seller penalty</dt>
          <dd>
            {pct(p.penaltyBps)} of the price if more than {pct(p.penaltyThresholdBps)} of tasks are confirmed broken
          </dd>
          {p.remediedMask > 0n && (
            <>
              <dt>Refunded tasks</dt>
              <dd>
                {maskToIndexes(p.remediedMask)
                  .map((i) => i + 1)
                  .join(", ")}
              </dd>
            </>
          )}
        </dl>
      </DetailSection>

      <DetailSection title="On-chain history">
        {eventsLoading ? <Skeleton className="h-24" /> : <EventList events={[...events].reverse()} compact empty="No events found for this purchase yet." />}
      </DetailSection>
    </Details>
  );
}

"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { RequireWallet } from "@/components/tx";
import { Countdown, Notice, PageHeader, PurchaseStateChip, Skeleton, Spinner, Stars, useNow } from "@/components/ui";
import { describe, useDoc } from "@/lib/docs";
import { fmtUsdc } from "@/lib/format";
import { tradeRows, useMarketEvents, usePurchase, useVersion, type Purchase } from "@/lib/market";
import { ClaimBanner } from "../../purchase/[id]/purchase-view";

export function MyPurchasesView() {
  const { address } = useAccount();
  return (
    <div className="space-y-10">
      <PageHeader title="My purchases">Each purchase with what to do next.</PageHeader>
      <DeploymentGate>
        <div className="max-w-md">
          <RequireWallet why="Sign in to see your purchases.">{null}</RequireWallet>
        </div>
        {address && <Body a={address} />}
      </DeploymentGate>
    </div>
  );
}

function Body({ a }: { a: Address }) {
  const events = useMarketEvents();
  const buys = useMemo(() => (events.data ? tradeRows(events.data) : []).filter((r) => r.buyer?.toLowerCase() === a.toLowerCase()).reverse(), [events.data, a]);
  return (
    <>
      <ClaimBanner />
      {events.isLoading ? (
        <Skeleton className="h-32" />
      ) : events.error ? (
        <Notice tone="bad" title="Couldn’t load your purchases">
          {(events.error as Error).message.split("\n")[0]} Reload the page to try again.
        </Notice>
      ) : buys.length === 0 ? (
        <p className="text-sm text-muted">
          No purchases yet.{" "}
          <Link href="/" className="link">
            Browse environments
          </Link>
          .
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {buys.map((r) => (
            <PurchaseRow key={r.purchaseId.toString()} id={r.purchaseId} />
          ))}
        </ul>
      )}
    </>
  );
}

function PurchaseRow({ id }: { id: bigint }) {
  const p = usePurchase(id);
  const v = useVersion(p.data?.versionId ?? null);
  const doc = useDoc(v.data?.uri, v.data?.descriptionHash);
  if (!p.data)
    return (
      <li className="flex items-center gap-2 px-4 py-3 text-sm text-muted sm:px-5">
        <Spinner className="h-3.5 w-3.5" /> Loading purchase #{id.toString()}…
      </li>
    );
  const title = describe(doc.data?.json).title ?? `Environment #${p.data.versionId}`;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5 text-sm sm:px-5">
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <Link href={`/purchase/${id}`} className="link font-medium">
          {title}
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <PurchaseStateChip state={p.data.state} long />
          <span>
            #{id.toString()} · <span className="font-mono tabular-nums">{fmtUsdc(p.data.price)}</span>
          </span>
          {p.data.rated && <Stars value={p.data.stars} size="text-xs" />}
        </div>
      </div>
      <NextStep p={p.data} />
    </li>
  );
}

/** The single next thing the buyer can do with this purchase. */
function NextStep({ p }: { p: Purchase }) {
  const now = useNow();
  const href = `/purchase/${p.id}`;
  const wrap = (x: ReactNode) => <div className="flex flex-wrap items-center gap-2">{x}</div>;
  if (p.state === "Funded")
    return now <= p.deliveryDeadline ? (
      <span className="text-xs text-muted">
        Key due in <Countdown to={p.deliveryDeadline} />
      </span>
    ) : (
      wrap(
        <Link href={href} className="btn btn-sm">
          Get a refund
        </Link>,
      )
    );
  if (p.state === "Delivered") {
    const open = now <= p.challengeDeadline;
    return wrap(
      <>
        {open && (
          <Link href={`${href}#report`} className="btn btn-sm btn-ghost">
            Report a problem
            <span className="text-xs font-normal text-muted">
              · <Countdown to={p.challengeDeadline} /> left
            </span>
          </Link>
        )}
        <Link href={href} className="btn btn-sm">
          Download
        </Link>
      </>,
    );
  }
  if (p.state === "Disputed")
    return wrap(
      <Link href={`/dispute/${p.disputeId}`} className="btn btn-sm">
        View report
      </Link>,
    );
  if (p.state === "Settled" && p.deliveredAt > 0)
    return wrap(
      !p.rated ? (
        <Link href={`${href}#rate`} className="btn btn-sm">
          Rate
        </Link>
      ) : (
        <Link href={href} className="btn btn-sm">
          Download
        </Link>
      ),
    );
  return null;
}

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { DeploymentGate } from "@/components/gate";
import { DepositAction, WithdrawAction } from "@/components/token-action";
import { RequireWallet } from "@/components/tx";
import { Card, Chip, PageHeader, Skeleton, Spinner, Stat, useNow, type Tone } from "@/components/ui";
import { describe, useDoc, useVerifiedReport } from "@/lib/docs";
import { fmtUsdc } from "@/lib/format";
import { isZeroHash, readOptional, tradeRows, useMarketEvents, usePreviewInfo, useSellerStake, useVersion } from "@/lib/market";
import { ClaimBanner } from "../../purchase/[id]/purchase-view";
import { KeeperRow, PreviewActions } from "../../seller/[address]/seller-view";

const SELL_README = "https://github.com/angadjosan/bab-takehome#readme";

export function MyEnvironmentsView() {
  const { address } = useAccount();
  return (
    <div className="space-y-10">
      <PageHeader
        title="My environments"
        actions={
          address ? (
            <Link href={`/seller/${address}`} className="btn btn-sm btn-ghost">
              Public profile
            </Link>
          ) : undefined
        }
      >
        Your listings, sales waiting on payment, and your stake.
      </PageHeader>
      <DeploymentGate>
        <div className="max-w-md">
          <RequireWallet why="Sign in to see your environments.">{null}</RequireWallet>
        </div>
        {address && <Body a={address} />}
      </DeploymentGate>
    </div>
  );
}

function Body({ a }: { a: Address }) {
  const events = useMarketEvents();
  const stake = useSellerStake(a);
  const versions = useQuery({
    queryKey: ["seller-versions", a],
    queryFn: async () => ((await readOptional("listVersionIdsBySeller", [a])) as bigint[] | undefined) ?? [],
    refetchInterval: 15_000,
  });
  const open = useMemo(
    () => (events.data ? tradeRows(events.data) : []).filter((r) => r.seller?.toLowerCase() === a.toLowerCase() && !r.settled && !r.fullRefund).reverse(),
    [events.data, a],
  );

  return (
    <>
      <ClaimBanner />

      <section aria-labelledby="listings-title" className="space-y-3">
        <h2 id="listings-title" className="text-sm font-semibold text-ink">
          Listings
        </h2>
        {versions.isLoading ? (
          <Skeleton className="h-16" />
        ) : !versions.data?.length ? (
          <p className="text-sm text-muted">
            List an environment with <code className="font-mono text-[13px] text-ink">./sell.sh</code>. See the{" "}
            <a href={SELL_README} target="_blank" rel="noreferrer" className="link">
              README
            </a>
            .
          </p>
        ) : (
          <ul className="card divide-y divide-line">
            {[...versions.data].reverse().map((id) => (
              <ListingRow key={id.toString()} id={id} />
            ))}
          </ul>
        )}
      </section>

      {open.length > 0 && (
        <section aria-labelledby="open-title" className="space-y-3">
          <h2 id="open-title" className="text-sm font-semibold text-ink">
            Open sales
          </h2>
          <ul className="card divide-y divide-line">
            {open.map((r) => (
              <KeeperRow key={r.purchaseId.toString()} id={r.purchaseId} />
            ))}
          </ul>
        </section>
      )}

      <Card title="Stake" subtitle="Collateral that backs open sales. Free stake can be withdrawn.">
        {!stake.data ? (
          <Skeleton className="h-28" />
        ) : (
          <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-1 sm:gap-4">
              <Stat label="Total" value={fmtUsdc(stake.data.total, { symbol: false })} />
              <Stat label="Backing open sales" value={fmtUsdc(stake.data.reserved, { symbol: false })} />
              <Stat label="Free" value={fmtUsdc(stake.data.available, { symbol: false })} />
            </div>
            <div className="space-y-5">
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-ink">Add stake</div>
                <DepositAction label="Deposit" functionName="depositCollateral" />
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-ink">Withdraw free stake</div>
                <WithdrawAction label="Withdraw" functionName="withdrawCollateral" max={stake.data.available} />
              </div>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function ListingRow({ id }: { id: bigint }) {
  const v = useVersion(id);
  const report = useVerifiedReport(v.data);
  const doc = useDoc(v.data?.uri, v.data?.descriptionHash);
  const pi = usePreviewInfo(id);
  const now = useNow();
  if (!v.data)
    return (
      <li className="flex items-center gap-2 px-4 py-3 text-sm text-muted sm:px-5">
        <Spinner className="h-3.5 w-3.5" /> Loading environment #{id.toString()}…
      </li>
    );
  const noReport = isZeroHash(v.data.reportHash);
  const rv = report.data;
  const chip: { text: string; tone: Tone } = !v.data.active
    ? { text: "Retired", tone: "neutral" }
    : noReport
      ? { text: "Preview pending", tone: "warn" }
      : rv && (!rv.hashMatchesChain || !rv.bundleMatches || !rv.versionMatches || rv.signatureValid === false)
        ? { text: "Report mismatch", tone: "bad" }
        : report.error
          ? { text: "Report unavailable", tone: "warn" }
          : rv
            ? { text: "Verified", tone: "ok" }
            : { text: "Checking", tone: "neutral" };
  const title = describe(doc.data?.json).title ?? `Environment #${id}`;
  const info = pi.data;
  const paid = !!info && info.paidAt > 0 && !info.reclaimed;
  return (
    <li className="space-y-3 px-4 py-3.5 text-sm sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link href={`/listing/${id}`} className="link min-w-0 font-medium">
          {title}
        </Link>
        <span className="text-xs text-muted">
          <span className="font-mono text-ink/85 tabular-nums">{fmtUsdc(v.data.price)}</span> · {v.data.taskCount} tasks
        </span>
        <Chip tone={chip.tone} dot className="sm:ml-auto">
          {chip.text}
        </Chip>
      </div>
      {v.data.active && noReport && info !== null && info !== undefined && (
        <PreviewActions versionId={id} paid={paid} reclaimable={paid && !info.released && now > info.deadline} deadline={info.deadline} />
      )}
    </li>
  );
}

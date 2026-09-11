"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { MarketEvent } from "@/lib/client";
import { fmtAgo, fmtTime, fmtUsdc, maskToIndexes } from "@/lib/format";
import { GROUND_LABEL, useBlockTimes } from "@/lib/market";
import { cx, TxLink, type Tone } from "./ui";

const s = (e: MarketEvent, k: string) => String(e.args[k] ?? "");
const b = (e: MarketEvent, k: string) => BigInt((e.args[k] as bigint) ?? 0n);
const tasks = (mask: bigint) => {
  const ix = maskToIndexes(mask).map((i) => i + 1);
  if (!ix.length) return "no tasks";
  return ix.length === 1 ? `task ${ix[0]}` : `tasks ${ix.join(", ")}`;
};

type Described = { title: ReactNode; detail?: ReactNode; tone: Tone; href?: string };

/** Plain-language title and one-line detail for every EnvMarket event. */
export function describeEvent(e: MarketEvent): Described {
  const listing = `/listing/${s(e, "versionId")}`;
  const purchase = `/purchase/${s(e, "purchaseId")}`;
  const dispute = `/dispute/${s(e, "disputeId")}`;
  switch (e.eventName) {
    case "ListingCreated":
      return { title: `New listing #${s(e, "listingId")}`, tone: "accent", href: listing };
    case "VersionCreated":
      return {
        title: `Environment #${s(e, "versionId")} listed`,
        detail: `Version ${s(e, "versionNo")} of listing #${s(e, "listingId")}${e.args.price !== undefined ? ` · ${fmtUsdc(b(e, "price"))}` : ""}`,
        tone: "accent",
        href: listing,
      };
    case "VersionActiveSet":
      return { title: `Environment #${s(e, "versionId")} ${e.args.active ? "back on sale" : "taken off sale"}`, tone: "neutral", href: listing };
    case "ReportAttached":
      return { title: `Signed preview published for environment #${s(e, "versionId")}`, tone: "info", href: listing };
    case "CollateralDeposited":
      return { title: "Seller added collateral", detail: fmtUsdc(b(e, "amount")), tone: "neutral", href: `/seller/${s(e, "seller")}` };
    case "CollateralWithdrawn":
      return { title: "Seller withdrew collateral", detail: fmtUsdc(b(e, "amount")), tone: "neutral", href: `/seller/${s(e, "seller")}` };
    case "Purchased":
      return { title: `Purchase #${s(e, "purchaseId")} paid`, detail: `${fmtUsdc(b(e, "price"))} held in escrow · environment #${s(e, "versionId")}`, tone: "accent", href: purchase };
    case "Delivered":
      return { title: `Key delivered for purchase #${s(e, "purchaseId")}`, detail: "Protection window started", tone: "info", href: purchase };
    case "RefundedUndelivered":
      return {
        title: `Purchase #${s(e, "purchaseId")} refunded`,
        detail: `Key not delivered in time${e.args.amount !== undefined ? ` · ${fmtUsdc(b(e, "amount"))} back to the buyer` : ""}`,
        tone: "warn",
        href: purchase,
      };
    case "DisputeOpened":
      return {
        title: `Problem reported on purchase #${s(e, "purchaseId")}`,
        detail: `${GROUND_LABEL[Number(e.args.ground)] ?? "Dispute"} · ${tasks(b(e, "taskMask"))} · asks for ${fmtUsdc(b(e, "requested"))} back`,
        tone: "warn",
        href: dispute,
      };
    case "SelectionArmed":
      return { title: `Jury draw scheduled for dispute #${s(e, "disputeId")}`, detail: `Round ${s(e, "round")}`, tone: "neutral", href: dispute };
    case "JurorsSelected":
      return { title: `Jury drawn for dispute #${s(e, "disputeId")}`, detail: `Round ${s(e, "round")} · 3 jurors`, tone: "info", href: dispute };
    case "VoteCommitted":
      return { title: "Juror voted (hidden)", detail: `Dispute #${s(e, "disputeId")}`, tone: "neutral", href: dispute };
    case "VoteRevealed":
      return { title: `Juror vote revealed: ${Number(e.args.verdict) === 1 ? "uphold" : "reject"}`, detail: `Dispute #${s(e, "disputeId")}`, tone: "neutral", href: dispute };
    case "JurorPaid":
      return { title: "Juror paid", detail: `${fmtUsdc(b(e, "amount"))} · dispute #${s(e, "disputeId")}`, tone: "ok", href: dispute };
    case "JurorSlashed":
      return {
        title: e.args.nonReveal ? "Juror penalized for not revealing" : "Juror penalized for a minority vote",
        detail: `${fmtUsdc(b(e, "amount"))} · dispute #${s(e, "disputeId")}`,
        tone: "bad",
        href: dispute,
      };
    case "RoundFailed":
      return { title: `Jury round ${s(e, "round")} had too few votes`, detail: `Dispute #${s(e, "disputeId")} · ${s(e, "reveals")} revealed`, tone: "warn", href: dispute };
    case "FallbackNoQuorum":
      return { title: "No jury majority", detail: `Dispute #${s(e, "disputeId")} · deposit returned, no refund`, tone: "warn", href: dispute };
    case "VerifierTimeout":
      return { title: "Review timed out", detail: `Dispute #${s(e, "disputeId")} · deposit returned, no refund`, tone: "warn", href: dispute };
    case "MechanicalResolved":
      return {
        title: e.args.upheld ? "Review confirmed a defect" : "Review found no defect",
        detail: `Dispute #${s(e, "disputeId")} · confirmed: ${maskToIndexes(b(e, "confirmedMask")).length ? tasks(b(e, "confirmedMask")) : "none"}`,
        tone: e.args.upheld ? "ok" : "neutral",
        href: dispute,
      };
    case "DisputeResolved":
      return {
        title: `Dispute #${s(e, "disputeId")} decided for the ${Number(e.args.verdict) === 1 ? "buyer" : "seller"}`,
        detail: `Refund ${fmtUsdc(b(e, "refund"))} · seller paid ${fmtUsdc(b(e, "sellerProceeds"))}${b(e, "penalties") > 0n ? ` · penalty ${fmtUsdc(b(e, "penalties"))}` : ""}`,
        tone: Number(e.args.verdict) === 1 ? "ok" : "neutral",
        href: dispute,
      };
    case "PurchaseSettled":
      return {
        title: `Payment released for purchase #${s(e, "purchaseId")}`,
        detail: `Seller ${fmtUsdc(b(e, "sellerProceeds"))} · refund ${fmtUsdc(b(e, "refund"))} · fee ${fmtUsdc(b(e, "fee"))}`,
        tone: "ok",
        href: purchase,
      };
    case "Rated":
      return { title: `Purchase #${s(e, "purchaseId")} rated ${Number(e.args.stars)} of 5`, detail: `Environment #${s(e, "versionId")}`, tone: "accent", href: purchase };
    case "JurorRegistered":
      return { title: e.args.approved ? "Juror approved" : "Juror removed", tone: "neutral", href: "/jurors" };
    case "JurorStakeChanged":
      return { title: "Juror stake changed", detail: `${fmtUsdc(b(e, "total"))} staked · ${fmtUsdc(b(e, "locked"))} locked`, tone: "neutral", href: "/jurors" };
    case "Credited":
      return { title: "Balance credited", detail: `${fmtUsdc(b(e, "amount"))} ready to withdraw`, tone: "neutral", href: `/seller/${s(e, "account")}` };
    case "Withdrawn":
      return { title: "Balance withdrawn", detail: fmtUsdc(b(e, "amount")), tone: "neutral", href: `/seller/${s(e, "account")}` };
    case "RunnerSet":
    case "RelaySet":
    case "VerifierSet":
      return { title: `${e.eventName.replace("Set", "")} role ${e.args.allowed ? "granted" : "revoked"}`, tone: "neutral" };
    case "ParamsUpdated":
      return { title: "Market terms updated", detail: "Applies to new purchases only", tone: "neutral" };
    case "PreviewRequested":
      return {
        title: `Preview paid for environment #${s(e, "versionId")}`,
        detail: e.args.fee !== undefined ? `${fmtUsdc(b(e, "fee"))} held until the signed report is attached` : "Fee held until the signed report is attached",
        tone: "neutral",
        href: listing,
      };
    case "PreviewFeeReleased":
      return { title: `Preview fee paid to the TEE operator`, detail: e.args.versionId !== undefined ? `Environment #${s(e, "versionId")}` : undefined, tone: "neutral", href: e.args.versionId !== undefined ? listing : undefined };
    case "PreviewFeeReclaimed":
      return { title: `Preview fee returned to the seller`, detail: e.args.versionId !== undefined ? `Environment #${s(e, "versionId")} · no report in time` : undefined, tone: "warn", href: e.args.versionId !== undefined ? listing : undefined };
    case "TreasuryWithdrawn":
      return { title: "Marketplace fees withdrawn", detail: e.args.amount !== undefined ? fmtUsdc(b(e, "amount")) : undefined, tone: "neutral" };
    case "ReserveWithdrawn":
      return { title: "Neutral reserve withdrawn", detail: e.args.amount !== undefined ? fmtUsdc(b(e, "amount")) : undefined, tone: "neutral" };
    default: {
      // unknown events still read as words: "SomethingHappened" → "Something happened"
      const words = e.eventName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
      return { title: words.charAt(0).toUpperCase() + words.slice(1), tone: "neutral" };
    }
  }
}

const DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
  neutral: "bg-faint",
  accent: "bg-accent",
};

export function EventList({ events, empty = "No events yet.", compact, showTx = true }: { events: MarketEvent[]; empty?: string; compact?: boolean; showTx?: boolean }) {
  const times = useBlockTimes(events.map((e) => e.blockNumber));
  if (!events.length) return <p className="py-3 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {events.map((e) => {
        const d = describeEvent(e);
        const t = times.data?.get(e.blockNumber);
        const body = (
          <div className="min-w-0">
            <div className={cx("text-sm text-ink", d.href && "group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-[3px]")}>{d.title}</div>
            {d.detail && !compact && <div className="mt-0.5 truncate text-xs text-muted">{d.detail}</div>}
          </div>
        );
        return (
          <li key={`${e.transactionHash}-${e.logIndex}`} className="flex items-start gap-3 py-3 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]">
            <span aria-hidden className={cx("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", DOT[d.tone])} />
            {d.href ? (
              <Link href={d.href} className="group min-w-0 flex-1">
                {body}
              </Link>
            ) : (
              <div className="min-w-0 flex-1">{body}</div>
            )}
            <div className="shrink-0 text-right">
              <div className="text-xs text-muted tabular-nums" title={t ? fmtTime(t) : undefined}>
                {t ? fmtAgo(t) : "…"}
              </div>
              {showTx && (
                <div className="mt-0.5">
                  <TxLink hash={e.transactionHash} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

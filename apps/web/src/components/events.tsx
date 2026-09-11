"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { MarketEvent } from "@/lib/client";
import { fmtAgo, fmtUsdc, maskToIndexes, shortAddr, shortHash } from "@/lib/format";
import { GROUND_LABEL, useBlockTimes } from "@/lib/market";
import { cx, TxLink } from "./ui";

const s = (e: MarketEvent, k: string) => String(e.args[k] ?? "");
const b = (e: MarketEvent, k: string) => BigInt((e.args[k] as bigint) ?? 0n);

type Described = { title: ReactNode; detail?: ReactNode; tone: "ok" | "warn" | "bad" | "info" | "neutral" | "accent"; href?: string };

export function describeEvent(e: MarketEvent): Described {
  switch (e.eventName) {
    case "ListingCreated":
      return { title: `Listing #${s(e, "listingId")} created`, detail: `by ${shortAddr(s(e, "seller"))}`, tone: "accent", href: `/listing/${s(e, "versionId")}` };
    case "VersionCreated":
      return { title: `Version #${s(e, "versionId")} published`, detail: `v${s(e, "versionNo")} of listing #${s(e, "listingId")}${e.args.price !== undefined ? ` · ${fmtUsdc(b(e, "price"))}` : ""}`, tone: "accent", href: `/listing/${s(e, "versionId")}` };
    case "VersionActiveSet":
      return { title: `Version #${s(e, "versionId")} ${e.args.active ? "activated" : "deactivated"}`, tone: "neutral", href: `/listing/${s(e, "versionId")}` };
    case "ReportAttached":
      return { title: `Signed preview attached to version #${s(e, "versionId")}`, detail: `runner ${shortAddr(s(e, "runner"))} · ${shortHash(s(e, "reportHash"))}`, tone: "info", href: `/listing/${s(e, "versionId")}` };
    case "CollateralDeposited":
      return { title: "Seller collateral deposited", detail: `${fmtUsdc(b(e, "amount"))} by ${shortAddr(s(e, "seller"))}`, tone: "neutral", href: `/seller/${s(e, "seller")}` };
    case "CollateralWithdrawn":
      return { title: "Seller collateral withdrawn", detail: `${fmtUsdc(b(e, "amount"))} by ${shortAddr(s(e, "seller"))}`, tone: "neutral", href: `/seller/${s(e, "seller")}` };
    case "Purchased":
      return { title: `Purchase #${s(e, "purchaseId")} funded`, detail: `${fmtUsdc(b(e, "price"))} into escrow for version #${s(e, "versionId")} by ${shortAddr(s(e, "buyer"))}`, tone: "accent", href: `/purchase/${s(e, "purchaseId")}` };
    case "Delivered":
      return { title: `Key delivered for purchase #${s(e, "purchaseId")}`, detail: `relay ${shortAddr(s(e, "relay"))} · challenge window started`, tone: "info", href: `/purchase/${s(e, "purchaseId")}` };
    case "RefundedUndelivered":
      return { title: `Purchase #${s(e, "purchaseId")} refunded (not delivered)`, detail: e.args.amount !== undefined ? `${fmtUsdc(b(e, "amount"))} back to buyer` : undefined, tone: "warn", href: `/purchase/${s(e, "purchaseId")}` };
    case "DisputeOpened":
      return {
        title: `Dispute #${s(e, "disputeId")} opened on purchase #${s(e, "purchaseId")}`,
        detail: `${GROUND_LABEL[Number(e.args.ground)] ?? "?"} · tasks ${maskToIndexes(b(e, "taskMask")).map((i) => i + 1).join(", ")} · requested ${fmtUsdc(b(e, "requested"))} · bond ${fmtUsdc(b(e, "bond"))}`,
        tone: "warn",
        href: `/dispute/${s(e, "disputeId")}`,
      };
    case "SelectionArmed":
      return { title: `Juror draw armed for dispute #${s(e, "disputeId")}`, detail: `round ${s(e, "round")} · randomness from block ${s(e, "selectionBlock")}`, tone: "neutral", href: `/dispute/${s(e, "disputeId")}` };
    case "JurorsSelected":
      return { title: `Jurors drawn for dispute #${s(e, "disputeId")}`, detail: `round ${s(e, "round")} · ${((e.args.jurors as string[]) ?? []).map(shortAddr).join(", ")}`, tone: "info", href: `/dispute/${s(e, "disputeId")}` };
    case "VoteCommitted":
      return { title: `Sealed vote committed`, detail: `dispute #${s(e, "disputeId")} · juror ${shortAddr(s(e, "juror"))}`, tone: "neutral", href: `/dispute/${s(e, "disputeId")}` };
    case "VoteRevealed":
      return { title: `Vote revealed: ${Number(e.args.verdict) === 1 ? "Uphold" : "Reject"}`, detail: `dispute #${s(e, "disputeId")} · juror ${shortAddr(s(e, "juror"))}`, tone: "neutral", href: `/dispute/${s(e, "disputeId")}` };
    case "JurorPaid":
      return { title: "Juror paid", detail: `${fmtUsdc(b(e, "amount"))} to ${shortAddr(s(e, "juror"))} · dispute #${s(e, "disputeId")}`, tone: "ok", href: `/dispute/${s(e, "disputeId")}` };
    case "JurorSlashed":
      return { title: `Juror slashed${e.args.nonReveal ? " (did not reveal)" : " (minority)"}`, detail: `${fmtUsdc(b(e, "amount"))} from ${shortAddr(s(e, "juror"))} · dispute #${s(e, "disputeId")}`, tone: "bad", href: `/dispute/${s(e, "disputeId")}` };
    case "RoundFailed":
      return { title: `Jury round ${s(e, "round")} failed`, detail: `dispute #${s(e, "disputeId")} · ${s(e, "reveals")} reveal(s)`, tone: "warn", href: `/dispute/${s(e, "disputeId")}` };
    case "FallbackNoQuorum":
      return { title: `No-quorum fallback applied`, detail: `dispute #${s(e, "disputeId")}: bond returned, no refund`, tone: "warn", href: `/dispute/${s(e, "disputeId")}` };
    case "VerifierTimeout":
      return { title: `Verifier timed out`, detail: `dispute #${s(e, "disputeId")}: no-fault fallback`, tone: "warn", href: `/dispute/${s(e, "disputeId")}` };
    case "MechanicalResolved":
      return { title: `Verifier finding: ${e.args.upheld ? "upheld" : "rejected"}`, detail: `dispute #${s(e, "disputeId")} · confirmed tasks ${maskToIndexes(b(e, "confirmedMask")).map((i) => i + 1).join(", ") || "none"}`, tone: e.args.upheld ? "ok" : "neutral", href: `/dispute/${s(e, "disputeId")}` };
    case "DisputeResolved":
      return {
        title: `Dispute #${s(e, "disputeId")} resolved: ${Number(e.args.verdict) === 1 ? "upheld" : "rejected"}`,
        detail: `refund ${fmtUsdc(b(e, "refund"))} · seller proceeds ${fmtUsdc(b(e, "sellerProceeds"))} · penalties ${fmtUsdc(b(e, "penalties"))}`,
        tone: Number(e.args.verdict) === 1 ? "ok" : "neutral",
        href: `/dispute/${s(e, "disputeId")}`,
      };
    case "PurchaseSettled":
      return { title: `Purchase #${s(e, "purchaseId")} settled`, detail: `seller ${fmtUsdc(b(e, "sellerProceeds"))} · refund ${fmtUsdc(b(e, "refund"))} · fee ${fmtUsdc(b(e, "fee"))}`, tone: "ok", href: `/purchase/${s(e, "purchaseId")}` };
    case "Rated":
      return { title: `Purchase #${s(e, "purchaseId")} rated ${"★".repeat(Number(e.args.stars))}`, detail: `version #${s(e, "versionId")}`, tone: "accent", href: `/purchase/${s(e, "purchaseId")}` };
    case "JurorRegistered":
      return { title: `Juror ${e.args.approved ? "approved" : "removed"}`, detail: shortAddr(s(e, "juror")), tone: "neutral" };
    case "JurorStakeChanged":
      return { title: "Juror stake changed", detail: `${shortAddr(s(e, "juror"))} · total ${fmtUsdc(b(e, "total"))} · locked ${fmtUsdc(b(e, "locked"))}`, tone: "neutral" };
    case "Credited":
      return { title: "Credited (claimable)", detail: `${fmtUsdc(b(e, "amount"))} to ${shortAddr(s(e, "account"))}`, tone: "neutral" };
    case "Withdrawn":
      return { title: "Withdrawn", detail: `${fmtUsdc(b(e, "amount"))} by ${shortAddr(s(e, "account"))}`, tone: "neutral" };
    case "RunnerSet":
    case "RelaySet":
    case "VerifierSet":
      return { title: `${e.eventName.replace("Set", "")} role ${e.args.allowed ? "granted" : "revoked"}`, detail: shortAddr(s(e, "account")), tone: "neutral" };
    case "ParamsUpdated":
      return { title: "Market parameters updated (future purchases only)", tone: "neutral" };
    default:
      return { title: e.eventName, tone: "neutral" };
  }
}

const DOT: Record<Described["tone"], string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  info: "bg-info",
  neutral: "bg-line-strong",
  accent: "bg-accent",
};

export function EventList({ events, empty = "No events yet.", compact }: { events: MarketEvent[]; empty?: string; compact?: boolean }) {
  const times = useBlockTimes(events.map((e) => e.blockNumber));
  if (!events.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {events.map((e) => {
        const d = describeEvent(e);
        const t = times.data?.get(e.blockNumber);
        const body = (
          <div className="min-w-0">
            <div className={cx("text-sm", d.href && "group-hover:text-accent")}>{d.title}</div>
            {d.detail && !compact && <div className="truncate text-xs text-muted">{d.detail}</div>}
          </div>
        );
        return (
          <li key={`${e.transactionHash}-${e.logIndex}`} className="group flex items-start gap-3 py-2.5">
            <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[d.tone])} />
            {d.href ? (
              <Link href={d.href} className="min-w-0 flex-1">
                {body}
              </Link>
            ) : (
              <div className="min-w-0 flex-1">{body}</div>
            )}
            <div className="shrink-0 text-right text-xs text-muted">
              <TxLink hash={e.transactionHash} />
              <div title={`block ${e.blockNumber}`}>{t ? fmtAgo(t) : `#${e.blockNumber}`}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

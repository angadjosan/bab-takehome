"use client";

import { useQuery } from "@tanstack/react-query";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { marketAbi, hasFunction } from "./abi";
import { deployment } from "./config";
import { getBlockTimes, getMarketEvents, publicClient, type MarketEvent } from "./client";

/* ------------------------------------------------------------------------------------
 * Typed, normalized views of EnvMarket state (contracts/src/EnvMarketStorage.sol).
 * Normalizers read struct fields by name (viem decodes named tuples to objects) with a
 * positional fallback, so a synced ABI and the transcribed fallback ABI both work.
 * ---------------------------------------------------------------------------------- */

export const PURCHASE_STATES = ["None", "Funded", "Delivered", "Disputed", "Refunded", "Settled"] as const;
export type PurchaseState = (typeof PURCHASE_STATES)[number];

export const GROUND_LABEL: Record<number, string> = {
  1: "Doesn’t match hash / broken",
  2: "Description is false",
  3: "Preview not reproducible",
};
/** openDispute sends FalseDescription to a jury; the other grounds wait for a verifier-signed finding (resolveMechanical). */
export const isMechanical = (g: number) => g === 1 || g === 3;
export const DISPUTE_STATUS = ["None", "Awaiting juror selection", "Voting / under review", "Resolved"] as const;
export const VERDICTS = ["None", "Uphold (buyer wins)", "Reject (seller wins)"] as const;

type Raw = unknown;

function f<T = unknown>(raw: Raw, name: string, index?: number): T | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  if (name in (raw as object)) return (raw as Record<string, T>)[name];
  if (Array.isArray(raw) && index !== undefined) return raw[index] as T;
  return undefined;
}
const big = (v: unknown) => (v === undefined || v === null ? 0n : BigInt(v as bigint));
const num = (v: unknown) => Number(v ?? 0);
const addr = (v: unknown) => getAddress(String(v ?? zeroAddress));
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const h32 = (v: unknown) => ((v as Hex) ?? ZERO32);
export const isZeroHash = (h?: string | null) => !h || /^0x0*$/.test(h);

async function read(functionName: string, args: unknown[] = []): Promise<Raw> {
  if (!deployment) throw new Error("not deployed");
  return publicClient.readContract({ address: deployment.market, abi: marketAbi, functionName, args } as never);
}

export async function readOptional(functionName: string, args: unknown[] = []): Promise<Raw | undefined> {
  if (!hasFunction(marketAbi, functionName)) return undefined;
  try {
    return await read(functionName, args);
  } catch {
    return undefined;
  }
}

/* --------------------------------- versions --------------------------------- */

export type Version = {
  id: bigint;
  seller: Address;
  listingId: bigint;
  versionNo: number;
  bundleHash: Hex;
  ciphertextHash: Hex;
  imageDigest: Hex;
  descriptionHash: Hex;
  manifestHash: Hex;
  licenseHash: Hex;
  taskRoot: Hex;
  auditRoot: Hex;
  taskCount: number;
  auditTaskCount: number;
  price: bigint;
  collateral: bigint;
  deliveryWindow: number;
  challengeWindow: number;
  reportHash: Hex;
  uri: string;
  active: boolean;
};

export function normVersion(id: bigint, r: Raw): Version {
  return {
    id,
    seller: addr(f(r, "seller", 0)),
    listingId: big(f(r, "listingId", 1)),
    versionNo: num(f(r, "versionNo", 2)),
    bundleHash: h32(f(r, "bundleHash", 3)),
    ciphertextHash: h32(f(r, "ciphertextHash", 4)),
    imageDigest: h32(f(r, "imageDigest", 5)),
    descriptionHash: h32(f(r, "descriptionHash", 6)),
    manifestHash: h32(f(r, "manifestHash", 7)),
    licenseHash: h32(f(r, "licenseHash", 8)),
    taskRoot: h32(f(r, "taskRoot", 9)),
    auditRoot: h32(f(r, "auditRoot", 10)),
    taskCount: num(f(r, "taskCount", 11)),
    auditTaskCount: num(f(r, "auditTaskCount", 12)),
    price: big(f(r, "price", 13)),
    collateral: big(f(r, "collateral", 14)),
    deliveryWindow: num(f(r, "deliveryWindow", 15)),
    challengeWindow: num(f(r, "challengeWindow", 16)),
    reportHash: h32(f(r, "reportHash", 17)),
    uri: String(f(r, "uri", 18) ?? ""),
    active: Boolean(f(r, "active", 19)),
  };
}

export async function fetchVersion(id: bigint): Promise<Version> {
  const v = normVersion(id, await read("getVersion", [id]));
  if (v.seller === zeroAddress) throw new Error(`Version #${id} does not exist`);
  return v;
}

export async function fetchVersions(): Promise<Version[]> {
  const next = big(await read("nextVersionId"));
  const ids: bigint[] = [];
  for (let i = 1n; i < next; i++) ids.push(i);
  return Promise.all(ids.map(fetchVersion));
}

export type VersionStats = { ratingSum: number; ratingCount: number; settledCount: number; disputesOpened: number; disputesUpheld: number; retainedVolume: bigint };
export async function fetchVersionStats(id: bigint): Promise<VersionStats> {
  const r = await read("versionStats", [id]);
  return {
    ratingSum: num(f(r, "ratingSum", 0)),
    ratingCount: num(f(r, "ratingCount", 1)),
    settledCount: num(f(r, "settledCount", 2)),
    disputesOpened: num(f(r, "disputesOpened", 3)),
    disputesUpheld: num(f(r, "disputesUpheld", 4)),
    retainedVolume: big(f(r, "retainedVolume", 5)),
  };
}

/* --------------------------------- purchases -------------------------------- */

export type Purchase = {
  id: bigint;
  versionId: bigint;
  buyer: Address;
  seller: Address;
  state: PurchaseState;
  stateIndex: number;
  price: bigint;
  collateral: bigint;
  buyerEncPubKey: Hex;
  fundedAt: number;
  deliveryDeadline: number;
  deliveredAt: number;
  challengeDeadline: number;
  challengeWindow: number;
  taskCount: number;
  feeBps: number;
  refundCapBps: number;
  penaltyThresholdBps: number;
  penaltyBps: number;
  bondFloor: bigint;
  bondCap: bigint;
  caseFee: bigint;
  ciphertextHash: Hex;
  wrappedKeyHash: Hex;
  wrapperHash: Hex;
  relay: Address;
  disputeId: bigint;
  remediedMask: bigint;
  refunded: bigint;
  sellerProceeds: bigint;
  fee: bigint;
  penalties: bigint;
  settledAt: number;
  rated: boolean;
  stars: number;
};

export function normPurchase(id: bigint, r: Raw): Purchase {
  const stateIndex = num(f(r, "state", 3));
  return {
    id,
    versionId: big(f(r, "versionId", 0)),
    buyer: addr(f(r, "buyer", 1)),
    seller: addr(f(r, "seller", 2)),
    state: PURCHASE_STATES[stateIndex] ?? "None",
    stateIndex,
    price: big(f(r, "price", 4)),
    collateral: big(f(r, "collateral", 5)),
    buyerEncPubKey: h32(f(r, "buyerEncPubKey", 6)),
    fundedAt: num(f(r, "fundedAt", 7)),
    deliveryDeadline: num(f(r, "deliveryDeadline", 8)),
    deliveredAt: num(f(r, "deliveredAt", 9)),
    challengeDeadline: num(f(r, "challengeDeadline", 10)),
    challengeWindow: num(f(r, "challengeWindow", 11)),
    taskCount: num(f(r, "taskCount", 12)),
    feeBps: num(f(r, "feeBps", 13)),
    refundCapBps: num(f(r, "refundCapBps", 14)),
    penaltyThresholdBps: num(f(r, "penaltyThresholdBps", 15)),
    penaltyBps: num(f(r, "penaltyBps", 16)),
    bondFloor: big(f(r, "bondFloor", 17)),
    bondCap: big(f(r, "bondCap", 18)),
    caseFee: big(f(r, "caseFee", 19)),
    ciphertextHash: h32(f(r, "ciphertextHash", 20)),
    wrappedKeyHash: h32(f(r, "wrappedKeyHash", 21)),
    wrapperHash: h32(f(r, "wrapperHash", 22)),
    relay: addr(f(r, "relay", 23)),
    disputeId: big(f(r, "disputeId", 24)),
    remediedMask: big(f(r, "remediedMask", 25)),
    refunded: big(f(r, "refunded", 26)),
    sellerProceeds: big(f(r, "sellerProceeds", 27)),
    fee: big(f(r, "fee", 28)),
    penalties: big(f(r, "penalties", 29)),
    settledAt: num(f(r, "settledAt", 30)),
    rated: Boolean(f(r, "rated", 31)),
    stars: num(f(r, "stars", 32)),
  };
}

export async function fetchPurchase(id: bigint): Promise<Purchase> {
  const p = normPurchase(id, await read("getPurchase", [id]));
  if (p.stateIndex === 0) throw new Error(`Purchase #${id} does not exist`);
  return p;
}

/* --------------------------------- disputes --------------------------------- */

export type Seat = { juror: Address; vote: number; revealed: boolean; commitment: Hex; reward: bigint; slashed: bigint };

export type Dispute = {
  id: bigint;
  purchaseId: bigint;
  ground: number;
  status: number;
  verdict: number;
  round: number;
  fallbackNoQuorum: boolean;
  taskMask: bigint;
  confirmedMask: bigint;
  evidenceHash: Hex;
  findingsHash: Hex;
  requested: bigint;
  bond: bigint;
  refund: bigint;
  caseFee: bigint;
  participationFee: bigint;
  jurorStake: bigint;
  minoritySlashBps: number;
  nonRevealSlashBps: number;
  commitWindow: number;
  revealWindow: number;
  openedAt: number;
  selectionBlock: bigint;
  selectionDeadline: number;
  commitDeadline: number;
  revealDeadline: number;
  verifierDeadline: number;
  resolvedAt: number;
  seats: Seat[]; // [0..2] round 1, [3..5] round 2
};

export function normDispute(id: bigint, raw: Raw): Dispute {
  const [d, seatsRaw] = Array.isArray(raw) && raw.length === 2 && typeof raw[0] === "object" ? (raw as [Raw, Raw[]]) : [raw, [] as Raw[]];
  const seats = (Array.isArray(seatsRaw) ? seatsRaw : []).map((s) => ({
    juror: addr(f(s, "juror", 0)),
    vote: num(f(s, "vote", 1)),
    revealed: Boolean(f(s, "revealed", 2)),
    commitment: h32(f(s, "commitment", 3)),
    reward: big(f(s, "reward", 4)),
    slashed: big(f(s, "slashed", 5)),
  }));
  return {
    id,
    purchaseId: big(f(d, "purchaseId", 0)),
    ground: num(f(d, "ground", 1)),
    status: num(f(d, "status", 2)),
    verdict: num(f(d, "verdict", 3)),
    round: num(f(d, "round", 4)),
    fallbackNoQuorum: Boolean(f(d, "fallbackNoQuorum", 5)),
    taskMask: big(f(d, "taskMask", 6)),
    confirmedMask: big(f(d, "confirmedMask", 7)),
    evidenceHash: h32(f(d, "evidenceHash", 8)),
    findingsHash: h32(f(d, "findingsHash", 9)),
    requested: big(f(d, "requested", 10)),
    bond: big(f(d, "bond", 11)),
    refund: big(f(d, "refund", 12)),
    caseFee: big(f(d, "caseFee", 13)),
    participationFee: big(f(d, "participationFee", 14)),
    jurorStake: big(f(d, "jurorStake", 15)),
    minoritySlashBps: num(f(d, "minoritySlashBps", 16)),
    nonRevealSlashBps: num(f(d, "nonRevealSlashBps", 17)),
    commitWindow: num(f(d, "commitWindow", 18)),
    revealWindow: num(f(d, "revealWindow", 19)),
    openedAt: num(f(d, "openedAt", 20)),
    selectionBlock: big(f(d, "selectionBlock", 21)),
    selectionDeadline: num(f(d, "selectionDeadline", 22)),
    commitDeadline: num(f(d, "commitDeadline", 23)),
    revealDeadline: num(f(d, "revealDeadline", 24)),
    verifierDeadline: num(f(d, "verifierDeadline", 25)),
    resolvedAt: num(f(d, "resolvedAt", 26)),
    seats,
  };
}

export async function fetchDispute(id: bigint): Promise<Dispute> {
  const d = normDispute(id, await read("getDispute", [id]));
  if (d.purchaseId === 0n) throw new Error(`Dispute #${id} does not exist`);
  return d;
}

/* ---------------------------------- sellers --------------------------------- */

export type SellerStake = { total: bigint; reserved: bigint; available: bigint };
export async function fetchSellerStake(a: Address): Promise<SellerStake> {
  const r = await read("sellerStake", [a]);
  return { total: big(f(r, "total", 0)), reserved: big(f(r, "reserved", 1)), available: big(f(r, "available", 2)) };
}

export type SellerScore = { qualifyingTx: bigint; eligible: boolean; weightedRatingSum: bigint; ratedRetained: bigint };
export async function fetchSellerScore(a: Address): Promise<SellerScore> {
  const r = await read("sellerScore", [a]);
  return {
    qualifyingTx: big(f(r, "qualifyingTx", 0)),
    eligible: Boolean(f(r, "eligible", 1)),
    weightedRatingSum: big(f(r, "weightedRatingSum", 2)),
    ratedRetained: big(f(r, "ratedRetained", 3)),
  };
}

export type SellerStats = { qualifyingTx: number; disputesOpened: number; disputesUpheld: number; fullRefunds: number; retainedVolume: bigint; weightedRatingSum: bigint; ratedRetained: bigint };
export async function fetchSellerStats(a: Address): Promise<SellerStats> {
  const r = await read("sellerStats", [a]);
  return {
    qualifyingTx: num(f(r, "qualifyingTx", 0)),
    disputesOpened: num(f(r, "disputesOpened", 1)),
    disputesUpheld: num(f(r, "disputesUpheld", 2)),
    fullRefunds: num(f(r, "fullRefunds", 3)),
    retainedVolume: big(f(r, "retainedVolume", 4)),
    weightedRatingSum: big(f(r, "weightedRatingSum", 5)),
    ratedRetained: big(f(r, "ratedRetained", 6)),
  };
}

/** Public constants of the deployed EnvMarket (never change after deployment). */
export type MarketConstants = { seats: number; qualifyThreshold: bigint; maxJurors: number; owner: Address };
export async function fetchMarketConstants(): Promise<MarketConstants> {
  const [seats, threshold, maxJurors, owner] = await Promise.all([read("SEATS"), read("QUALIFYING_TX_THRESHOLD"), read("MAX_JURORS"), read("owner")]);
  return { seats: num(seats), qualifyThreshold: big(threshold), maxJurors: num(maxJurors), owner: addr(owner) };
}

export async function fetchIsRunner(a: Address): Promise<boolean | undefined> {
  const v = await readOptional("isRunner", [a]);
  return typeof v === "boolean" ? v : undefined;
}

export async function fetchIsVerifier(a: Address): Promise<boolean | undefined> {
  const v = await readOptional("isVerifier", [a]);
  return typeof v === "boolean" ? v : undefined;
}
export function useIsVerifier(a?: Address | null) {
  return useQuery({ queryKey: ["is-verifier", a], queryFn: () => fetchIsVerifier(a!), enabled: on && !!a, staleTime: 60_000 });
}

export async function fetchClaimable(a: Address): Promise<bigint | undefined> {
  const v = await readOptional("claimable", [a]);
  return v === undefined ? undefined : big(v);
}

/* ------------------------------ preview fee escrow ------------------------------ */

/** requestPreview escrow: fee paid by the seller, released to the TEE operator on attachReport. */
export type PreviewInfo = { fee: bigint; paidAt: number; quoteHash: Hex; released: boolean; reclaimed: boolean; deadline: number };
export async function fetchPreviewInfo(versionId: bigint): Promise<PreviewInfo | null> {
  const r = await readOptional("previewInfo", [versionId]);
  if (r === undefined) return null; // deployment predates seller-paid previews
  const dl = await readOptional("previewDeadline", [versionId]);
  return {
    fee: big(f(r, "fee", 0)),
    paidAt: num(f(r, "paidAt", 1)),
    quoteHash: h32(f(r, "quoteHash", 2)),
    released: Boolean(f(r, "released", 3)),
    reclaimed: Boolean(f(r, "reclaimed", 4)),
    deadline: num(dl),
  };
}
export function usePreviewInfo(versionId: bigint | null | undefined) {
  return useQuery({ queryKey: ["preview-info", versionId?.toString()], queryFn: () => fetchPreviewInfo(versionId!), enabled: on && versionId != null, refetchInterval: 10_000 });
}

/* ---------------------------------- jurors ---------------------------------- */

export type JurorInfo = { address: Address; approved: boolean; total: bigint; locked: bigint; free: bigint };
export async function fetchJurorInfo(a: Address): Promise<JurorInfo> {
  const r = await read("jurorInfo", [a]);
  return { address: a, approved: Boolean(f(r, "approved", 0)), total: big(f(r, "total", 1)), locked: big(f(r, "locked", 2)), free: big(f(r, "free", 3)) };
}
/** Every address ever approved as a juror (registry capped at 200), with current stake. */
export async function fetchJurors(): Promise<JurorInfo[]> {
  const list = ((await read("jurorList")) as Address[]).map((a) => getAddress(a));
  return Promise.all(list.map(fetchJurorInfo));
}

/* ---------------------------------- params ---------------------------------- */

export type Params = {
  challengeWindow: number;
  deliveryWindow: number;
  refundCapBps: number;
  penaltyThresholdBps: number;
  penaltyBps: number;
  feeBps: number;
  bondFloor: bigint;
  bondCap: bigint;
  caseFee: bigint;
  participationFee: bigint;
  jurorStake: bigint;
  minoritySlashBps: number;
  nonRevealSlashBps: number;
  commitWindow: number;
  revealWindow: number;
  verifierTimeout: number;
};

export async function fetchParams(): Promise<Params> {
  const r = await read("params");
  return {
    challengeWindow: num(f(r, "challengeWindow", 0)),
    deliveryWindow: num(f(r, "deliveryWindow", 1)),
    refundCapBps: num(f(r, "refundCapBps", 2)),
    penaltyThresholdBps: num(f(r, "penaltyThresholdBps", 3)),
    penaltyBps: num(f(r, "penaltyBps", 4)),
    feeBps: num(f(r, "feeBps", 5)),
    bondFloor: big(f(r, "bondFloor", 6)),
    bondCap: big(f(r, "bondCap", 7)),
    caseFee: big(f(r, "caseFee", 8)),
    participationFee: big(f(r, "participationFee", 9)),
    jurorStake: big(f(r, "jurorStake", 10)),
    minoritySlashBps: num(f(r, "minoritySlashBps", 11)),
    nonRevealSlashBps: num(f(r, "nonRevealSlashBps", 12)),
    commitWindow: num(f(r, "commitWindow", 13)),
    revealWindow: num(f(r, "revealWindow", 14)),
    verifierTimeout: num(f(r, "verifierTimeout", 15)),
  };
}

/* ---------------------------------- hooks ---------------------------------- */

const on = !!deployment;
export function useMarketEvents() {
  return useQuery({ queryKey: ["market-events"], queryFn: getMarketEvents, enabled: on, refetchInterval: 12_000 });
}
export function useVersions() {
  return useQuery({ queryKey: ["versions"], queryFn: fetchVersions, enabled: on, refetchInterval: 30_000 });
}
export function useVersion(id: bigint | null) {
  return useQuery({ queryKey: ["version", id?.toString()], queryFn: () => fetchVersion(id!), enabled: on && id !== null, retry: 0 });
}
export function useVersionStats(id: bigint | null | undefined) {
  return useQuery({ queryKey: ["vstats", id?.toString()], queryFn: () => fetchVersionStats(id!), enabled: on && id != null, refetchInterval: 20_000 });
}
export function usePurchase(id: bigint | null) {
  return useQuery({ queryKey: ["purchase", id?.toString()], queryFn: () => fetchPurchase(id!), enabled: on && id !== null, refetchInterval: 6_000, retry: 0 });
}
export function useDispute(id: bigint | null) {
  return useQuery({ queryKey: ["dispute", id?.toString()], queryFn: () => fetchDispute(id!), enabled: on && id !== null, refetchInterval: 5_000, retry: 0 });
}
export function useSellerStake(a?: Address | null) {
  return useQuery({ queryKey: ["stake", a], queryFn: () => fetchSellerStake(a!), enabled: on && !!a, refetchInterval: 20_000 });
}
export function useSellerScore(a?: Address | null) {
  return useQuery({ queryKey: ["score", a], queryFn: () => fetchSellerScore(a!), enabled: on && !!a, refetchInterval: 30_000 });
}
export function useSellerStats(a?: Address | null) {
  return useQuery({ queryKey: ["sstats", a], queryFn: () => fetchSellerStats(a!), enabled: on && !!a, refetchInterval: 30_000 });
}
export function useClaimable(a?: Address | null) {
  return useQuery({ queryKey: ["claimable", a], queryFn: () => fetchClaimable(a!), enabled: on && !!a, refetchInterval: 10_000 });
}
export function useMarketParams() {
  return useQuery({ queryKey: ["params"], queryFn: fetchParams, enabled: on, staleTime: 60_000 });
}
export function useMarketConstants() {
  return useQuery({ queryKey: ["market-constants"], queryFn: fetchMarketConstants, enabled: on, staleTime: Infinity });
}
export function useBlockNumber() {
  return useQuery({ queryKey: ["block"], queryFn: () => publicClient.getBlockNumber(), enabled: on, refetchInterval: 4_000 });
}
export function useBlockTimes(blocks: bigint[]) {
  const key = [...new Set(blocks.map(String))].sort().join(",");
  return useQuery({ queryKey: ["block-times", key], queryFn: () => getBlockTimes(blocks), enabled: blocks.length > 0, staleTime: Infinity });
}

/* --------------------------- derived from event logs --------------------------- */

export const argBig = (e: MarketEvent, k: string) => big(e.args[k]);
export const argAddr = (e: MarketEvent, k: string) => (e.args[k] ? getAddress(String(e.args[k])) : undefined);

/** Events that concern a purchase, including its disputes' events. */
export function eventsForPurchase(events: MarketEvent[], purchaseId: bigint): MarketEvent[] {
  const pid = purchaseId.toString();
  const disputeIds = new Set(events.filter((e) => e.eventName === "DisputeOpened" && String(e.args.purchaseId) === pid).map((e) => String(e.args.disputeId)));
  return events.filter((e) => String(e.args.purchaseId) === pid || (e.args.disputeId !== undefined && disputeIds.has(String(e.args.disputeId))));
}

export function eventsForDispute(events: MarketEvent[], disputeId: bigint): MarketEvent[] {
  const did = disputeId.toString();
  return events.filter((e) => String(e.args.disputeId) === did);
}

export type TradeRow = { purchaseId: bigint; versionId: bigint; buyer?: Address; seller?: Address; price: bigint; retained?: bigint; settled: boolean; fullRefund: boolean; disputed: boolean; stars?: number };

/** Per-purchase rows from Purchased / PurchaseSettled / RefundedUndelivered / DisputeOpened / Rated. */
export function tradeRows(events: MarketEvent[]): TradeRow[] {
  const rows = new Map<string, TradeRow>();
  for (const e of events) {
    const pid = e.args.purchaseId === undefined ? undefined : String(e.args.purchaseId);
    if (!pid) continue;
    if (e.eventName === "Purchased") {
      rows.set(pid, {
        purchaseId: big(e.args.purchaseId),
        versionId: argBig(e, "versionId"),
        buyer: argAddr(e, "buyer"),
        seller: argAddr(e, "seller"),
        price: argBig(e, "price"),
        settled: false,
        fullRefund: false,
        disputed: false,
      });
      continue;
    }
    const r = rows.get(pid);
    if (!r) continue;
    if (e.eventName === "PurchaseSettled") {
      r.settled = true;
      r.retained = r.price - argBig(e, "refund");
      if (r.retained === 0n) r.fullRefund = true;
    }
    if (e.eventName === "RefundedUndelivered") r.fullRefund = true;
    if (e.eventName === "DisputeOpened") r.disputed = true;
    if (e.eventName === "Rated") r.stars = num(e.args.stars);
  }
  return [...rows.values()];
}

export type Concentration = { counterparties: { buyer: Address; volume: bigint; count: number }[]; distinct: number; largestShare: number; totalRetained: bigint };

/** Distinct counterparties and the largest buyer's share of retained volume for a seller. */
export function concentration(rows: TradeRow[], seller: Address): Concentration {
  const mine = rows.filter((r) => r.seller?.toLowerCase() === seller.toLowerCase() && r.settled && (r.retained ?? 0n) > 0n);
  const m = new Map<string, { buyer: Address; volume: bigint; count: number }>();
  let total = 0n;
  for (const r of mine) {
    if (!r.buyer) continue;
    const c = m.get(r.buyer) ?? { buyer: r.buyer, volume: 0n, count: 0 };
    c.volume += r.retained!;
    c.count++;
    m.set(r.buyer, c);
    total += r.retained!;
  }
  const counterparties = [...m.values()].sort((a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0));
  const largestShare = total > 0n && counterparties[0] ? Number((counterparties[0].volume * 10000n) / total) / 100 : 0;
  return { counterparties, distinct: counterparties.length, largestShare, totalRetained: total };
}

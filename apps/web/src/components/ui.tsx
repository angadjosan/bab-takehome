"use client";

import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { addressUrl, txUrl } from "@/lib/config";
import { fmtDuration, shortAddr, shortHash } from "@/lib/format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/* ---------------------------------- icons ---------------------------------- */
/* One family: 20px grid, 1.6 stroke, round caps. Always decorative (aria-hidden); controls carry their own label. */

type IconProps = { className?: string };
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function IconCheck({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke} strokeWidth={2}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}
export function IconX({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke} strokeWidth={2}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  );
}
export function IconExternal({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M11 4h5v5M16 4l-7 7M8 5H5a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3" />
    </svg>
  );
}
export function IconCopy({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-6A1.5 1.5 0 004 5.5v6A1.5 1.5 0 005.5 13H7" />
    </svg>
  );
}
export function IconArrowLeft({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M16 10H4M9 5l-5 5 5 5" />
    </svg>
  );
}
export function IconArrowRight({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M4 10h12M11 5l5 5-5 5" />
    </svg>
  );
}
export function IconShield({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M10 2.5l6 2.2v4.6c0 3.9-2.6 6.9-6 8.2-3.4-1.3-6-4.3-6-8.2V4.7l6-2.2z" />
      <path d="M7.3 10l1.9 1.9 3.6-3.8" />
    </svg>
  );
}
export function IconAlert({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M10 3l7.5 13h-15L10 3z" />
      <path d="M10 8.5v3.2M10 14.1v.1" />
    </svg>
  );
}
export function IconInfo({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9v4.5M10 6.4v.1" />
    </svg>
  );
}
export function Spinner({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------- chips ---------------------------------- */

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "accent";
const CHIP: Record<Tone, string> = {
  ok: "badge-ok",
  warn: "badge-warn",
  bad: "badge-bad",
  info: "badge-info",
  neutral: "badge-neutral",
  accent: "badge-accent",
};
const DOT_BG: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info", neutral: "bg-faint", accent: "bg-accent" };

/** Status chip: a tinted label, optionally led by a dot. The text always carries the meaning; color only reinforces it. */
export function Chip({ tone = "neutral", dot, children, title, className }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={cx("badge", CHIP[tone], className)} title={title}>
      {dot && <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT_BG[tone])} />}
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral", className }: { tone?: Tone; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", DOT_BG[tone], className)} />;
}

export const PURCHASE_TONE: Record<string, Tone> = { Funded: "info", Delivered: "accent", Disputed: "warn", Refunded: "neutral", Settled: "ok" };
const PURCHASE_LABEL: Record<string, string> = { Funded: "Funded · awaiting key", Delivered: "Delivered · in challenge", Disputed: "Disputed", Refunded: "Refunded", Settled: "Settled" };

/** Purchase lifecycle state as a chip (Funded → Delivered → [Disputed] → Settled, or Refunded). */
export function PurchaseStateChip({ state, long }: { state: string; long?: boolean }) {
  return (
    <Chip tone={PURCHASE_TONE[state] ?? "neutral"} dot>
      {long ? (PURCHASE_LABEL[state] ?? state) : state}
    </Chip>
  );
}

/* ------------------------------ hashes & addresses ------------------------------ */

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-faint transition-colors duration-150 hover:bg-panel-2 hover:text-ink"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
      title={`Copy ${label ?? "value"}`}
      aria-label={`Copy ${label ?? "value"}`}
    >
      {done ? <IconCheck className="h-3.5 w-3.5 text-ok" /> : <IconCopy />}
      <span className="sr-only" aria-live="polite">
        {done ? "Copied" : ""}
      </span>
    </button>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span translate="no" className={cx("font-mono text-[0.9em]", className)}>
      {children}
    </span>
  );
}

/** A 32-byte hash: truncated (full value in the title and on copy), or wrapped in full. */
export function HashValue({ value, full, n }: { value?: string | null; full?: boolean; n?: number }) {
  if (!value) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-0.5 align-middle">
      <Mono className={full ? "[overflow-wrap:anywhere]" : "whitespace-nowrap"}>
        <span title={full ? undefined : value}>{full ? value : shortHash(value, n)}</span>
      </Mono>
      <CopyButton value={value} label="hash" />
    </span>
  );
}

export function Verified({ ok, pending, okText = "verified", badText = "mismatch", title }: { ok?: boolean | null; pending?: boolean; okText?: string; badText?: string; title?: string }) {
  if (pending)
    return (
      <span className="badge badge-neutral" title={title}>
        <Spinner className="h-3 w-3" /> checking…
      </span>
    );
  if (ok === undefined || ok === null)
    return (
      <span className="badge badge-neutral" title={title}>
        unverified
      </span>
    );
  return ok ? (
    <span className="badge badge-ok" title={title}>
      <IconCheck className="h-3 w-3" /> {okText}
    </span>
  ) : (
    <span className="badge badge-bad" title={title}>
      <IconX className="h-3 w-3" /> {badText}
    </span>
  );
}

export function TxLink({ hash, label }: { hash?: string | null; label?: string }) {
  if (!hash) return null;
  const u = txUrl(hash);
  const text = label ?? shortHash(hash, 6);
  return u ? (
    <a href={u} target="_blank" rel="noreferrer" translate="no" title={hash} className="inline-flex items-center gap-1 font-mono text-xs text-muted underline decoration-line-strong underline-offset-[3px] transition-colors duration-150 hover:text-ink hover:decoration-accent">
      {text}
      <IconExternal className="h-3 w-3" />
    </a>
  ) : (
    <Mono className="text-xs text-muted">
      <span title={hash}>{text}</span>
    </Mono>
  );
}

/** Address: truncated mono, copy, explorer link; `seller` links to the in-app account page. */
export function AddressLink({ address, seller, label }: { address?: string | null; seller?: boolean; label?: string }) {
  if (!address) return <span className="text-faint">—</span>;
  const ext = addressUrl(address);
  return (
    <span className="inline-flex items-center gap-0.5 align-middle whitespace-nowrap">
      {seller ? (
        <Link href={`/seller/${address}`} translate="no" title={address} className="link font-mono text-[0.9em]">
          {label ?? shortAddr(address)}
        </Link>
      ) : (
        <Mono>
          <span title={address}>{label ?? shortAddr(address)}</span>
        </Mono>
      )}
      <CopyButton value={address} label="address" />
      {ext && (
        <a
          href={ext}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-faint transition-colors duration-150 hover:bg-panel-2 hover:text-ink"
          title="View on block explorer"
          aria-label="View address on block explorer"
        >
          <IconExternal />
        </a>
      )}
    </span>
  );
}

/* ---------------------------------- time ---------------------------------- */

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Countdown({ to, doneText = "passed" }: { to?: number | bigint | null; doneText?: string }) {
  const now = useNow();
  if (!to) return <span className="text-faint">—</span>;
  const left = Number(to) - now;
  if (left <= 0) return <span className="text-muted">{doneText}</span>;
  return <span className="font-mono tabular-nums">{fmtDuration(left)}</span>;
}

/* --------------------------------- layout --------------------------------- */

export function PageHeader({ eyebrow, title, children, actions, back, meta }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode; back?: { href: string; label: ReactNode }; meta?: ReactNode }) {
  return (
    <header className="space-y-3">
      {back && <BackLink href={back.href}>{back.label}</BackLink>}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-2">
          {eyebrow && <div className="section-title">{eyebrow}</div>}
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px] sm:leading-9">{title}</h1>
          {children && <div className="max-w-[72ch] text-[15px] leading-relaxed text-muted">{children}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {meta && <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-muted">{meta}</div>}
    </header>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted transition-colors duration-150 hover:text-ink">
      <IconArrowLeft />
      <span className="truncate">{children}</span>
    </Link>
  );
}

export function Card({ title, subtitle, action, children, className, pad = true, id }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string }) {
  return (
    <section id={id} className={cx("card min-w-0", className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 max-w-[80ch] text-xs leading-relaxed text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={pad ? "card-pad" : ""}>{children}</div>
    </section>
  );
}

export function IconChevron({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden {...stroke}>
      <path d="M7.5 5l5 5-5 5" />
    </svg>
  );
}

/**
 * The one place crypto detail lives: a collapsed disclosure with a plain summary line
 * (e.g. "✓ Verified in your browser · 9 checks"). Hashes, addresses, signatures and tx links go inside.
 */
export function Details({ summary, status, children, defaultOpen, id, className }: { summary: ReactNode; status?: "ok" | "bad" | "pending" | "neutral"; children: ReactNode; defaultOpen?: boolean; id?: string; className?: string }) {
  return (
    <details id={id} open={defaultOpen} className={cx("group card overflow-hidden", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors duration-150 select-none hover:bg-panel-2 sm:px-5 [&::-webkit-details-marker]:hidden">
        {status === "ok" ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
            <IconCheck className="h-3 w-3" />
          </span>
        ) : status === "bad" ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad">
            <IconX className="h-3 w-3" />
          </span>
        ) : status === "pending" ? (
          <Spinner className="h-4 w-4 shrink-0 text-muted" />
        ) : null}
        <span className="min-w-0 flex-1 text-sm text-ink">{summary}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
          <IconChevron className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-90" />
        </span>
      </summary>
      <div className="space-y-6 border-t border-line px-4 py-4 sm:px-5 sm:py-5">{children}</div>
    </details>
  );
}

/** A labelled section inside Details. */
export function DetailSection({ title, children, hint }: { title: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="section-title">{title}</h3>
      {hint && <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-muted">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="section-title">{label}</div>
      <div className="mt-1.5 truncate font-mono text-lg font-medium tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "ok" | "neutral"; title?: ReactNode; children?: ReactNode }) {
  const tones = {
    info: "border-info/30 bg-info-soft [--tone:var(--info)]",
    warn: "border-warn/30 bg-warn-soft [--tone:var(--warn)]",
    bad: "border-bad/30 bg-bad-soft [--tone:var(--bad)]",
    ok: "border-ok/30 bg-ok-soft [--tone:var(--ok)]",
    neutral: "border-line bg-panel-2 [--tone:var(--muted)]",
  } as const;
  return (
    <div className={cx("flex gap-2.5 rounded-md border px-3.5 py-3 text-[13px]", tones[tone])}>
      {tone === "warn" || tone === "bad" ? (
        <IconAlert className="mt-px h-4 w-4 shrink-0 text-[var(--tone)]" />
      ) : tone === "ok" ? (
        <IconCheck className="mt-px h-4 w-4 shrink-0 text-[var(--tone)]" />
      ) : (
        <IconInfo className="mt-px h-4 w-4 shrink-0 text-[var(--tone)]" />
      )}
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold text-[var(--tone)]">{title}</div>}
        {children && <div className={cx(title ? "mt-1" : "", "leading-relaxed text-ink/85 [overflow-wrap:anywhere]")}>{children}</div>}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line-strong px-5 py-8 sm:px-8 sm:py-10">
      <div className="max-w-xl">
        <div className="text-sm font-semibold text-ink">{title}</div>
        {children && <div className="mt-2 text-[13px] leading-relaxed text-muted">{children}</div>}
        {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded bg-panel-2", className)} />;
}

function Star({ fill }: { fill: "full" | "half" | "none" }) {
  const id = `star-half-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 20 20" className="h-[1em] w-[1em]" aria-hidden>
      {fill === "half" && (
        <defs>
          <linearGradient id={id}>
            <stop offset="50%" stopColor="currentColor" />
            <stop offset="50%" stopColor="transparent" />
          </linearGradient>
        </defs>
      )}
      <path
        d="M10 1.8l2.5 5.2 5.7.8-4.1 4 1 5.6L10 14.8l-5.1 2.6 1-5.6-4.1-4 5.7-.8L10 1.8z"
        fill={fill === "full" ? "currentColor" : fill === "half" ? `url(#${id})` : "none"}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Stars({ value, size = "text-base" }: { value: number; size?: string }) {
  const full = Math.round(value * 2) / 2;
  return (
    <span role="img" className={cx("inline-flex items-center gap-px text-accent", size)} aria-label={`${value.toFixed(2)} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} fill={i <= full ? "full" : i - 0.5 === full ? "half" : "none"} />
      ))}
    </span>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = (error as { shortMessage?: string }).shortMessage ?? (error as Error).message ?? String(error);
  return (
    <p role="alert" className="mt-2 text-xs text-bad [overflow-wrap:anywhere]">
      {msg}
    </p>
  );
}

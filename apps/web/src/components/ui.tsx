"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { addressUrl, txUrl } from "@/lib/config";
import { fmtDuration, shortAddr, shortHash } from "@/lib/format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/* ---------------------------------- icons --------------------------------- */

export function IconCheck({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
    </svg>
  );
}
export function IconX({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <path fillRule="evenodd" d="M4.3 4.3a1 1 0 011.4 0L10 8.6l4.3-4.3a1 1 0 111.4 1.4L11.4 10l4.3 4.3a1 1 0 01-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 01-1.4-1.4L8.6 10 4.3 5.7a1 1 0 010-1.4z" clipRule="evenodd" />
    </svg>
  );
}
export function IconExternal({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden>
      <path d="M11 4h5v5M16 4l-7 7M8 5H5a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconCopy({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 7V5.5A1.5 1.5 0 0011.5 4h-6A1.5 1.5 0 004 5.5v6A1.5 1.5 0 005.5 13H7" />
    </svg>
  );
}
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* --------------------------------- pieces --------------------------------- */

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-panel-2 hover:text-ink"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
      title={`Copy ${label ?? value}`}
      aria-label={`Copy ${label ?? "value"}`}
    >
      {done ? <IconCheck className="h-3.5 w-3.5 text-ok" /> : <IconCopy />}
    </button>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.82em]", className)}>{children}</span>;
}

export function HashValue({ value, full, n }: { value?: string | null; full?: boolean; n?: number }) {
  if (!value) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      <Mono className={full ? "break-all" : ""}>{full ? value : shortHash(value, n)}</Mono>
      <CopyButton value={value} />
    </span>
  );
}

export function Verified({ ok, pending, okText = "verified", badText = "mismatch", title }: { ok?: boolean | null; pending?: boolean; okText?: string; badText?: string; title?: string }) {
  if (pending) return <span className="badge badge-neutral" title={title}><Spinner className="h-3 w-3" /> checking</span>;
  if (ok === undefined || ok === null) return <span className="badge badge-neutral" title={title}>unverified</span>;
  return ok ? (
    <span className="badge badge-ok" title={title}><IconCheck className="h-3 w-3" /> {okText}</span>
  ) : (
    <span className="badge badge-bad" title={title}><IconX className="h-3 w-3" /> {badText}</span>
  );
}

export function TxLink({ hash, label }: { hash?: string | null; label?: string }) {
  if (!hash) return null;
  const u = txUrl(hash);
  const text = label ?? shortHash(hash, 6);
  return u ? (
    <a href={u} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 font-mono text-xs">
      {text} <IconExternal />
    </a>
  ) : (
    <Mono className="text-xs">{text}</Mono>
  );
}

export function AddressLink({ address, seller, label }: { address?: string | null; seller?: boolean; label?: string }) {
  if (!address) return <span className="text-faint">—</span>;
  const ext = addressUrl(address);
  return (
    <span className="inline-flex items-center gap-1">
      {seller ? (
        <Link href={`/seller/${address}`} className="link font-mono text-[0.82em]">
          {label ?? shortAddr(address)}
        </Link>
      ) : (
        <Mono>{label ?? shortAddr(address)}</Mono>
      )}
      <CopyButton value={address} label="address" />
      {ext && (
        <a href={ext} target="_blank" rel="noreferrer" className="text-muted hover:text-ink" title="View on explorer">
          <IconExternal />
        </a>
      )}
    </span>
  );
}

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

export function Card({ title, subtitle, action, children, className, pad = true }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("card", className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={pad ? "card-pad" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="section-title">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "ok" | "neutral"; title?: ReactNode; children?: ReactNode }) {
  const tones = {
    info: "bg-info-soft text-info",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    ok: "bg-ok-soft text-ok",
    neutral: "bg-panel-2 text-muted",
  } as const;
  return (
    <div className={cx("rounded-lg px-4 py-3 text-sm", tones[tone])}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={cx(title ? "mt-1" : "", "leading-relaxed [&_a]:underline")}>{children}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="text-sm font-semibold">{title}</div>
      {children && <div className="mt-2 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-panel-2", className)} />;
}

export function Stars({ value, size = "text-base" }: { value: number; size?: string }) {
  const full = Math.round(value * 2) / 2;
  return (
    <span className={cx("inline-flex tracking-tight", size)} aria-label={`${value.toFixed(2)} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= full ? "text-warn" : i - 0.5 === full ? "text-warn opacity-60" : "text-line-strong"}>
          ★
        </span>
      ))}
    </span>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = (error as { shortMessage?: string }).shortMessage ?? (error as Error).message ?? String(error);
  return <p className="mt-2 break-words text-xs text-bad">{msg}</p>;
}

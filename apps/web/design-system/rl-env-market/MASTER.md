# Design System Master File

> Generated with the ui-ux-pro-max skill (`--design-system`, variance 4, motion 3, density 8), then
> curated by hand. Where the generated output conflicted with the product, the curated choice below
> wins. Page overrides live in `design-system/rl-env-market/pages/<page>.md` (none yet).
> Rationale and component inventory: `apps/web/DESIGN.md`. Implementation: `src/app/globals.css`.

**Project:** RL Environment Market (testnet)
**Category:** Marketplace for sealed RL environments; trust-critical, money-moving
**Style:** Minimalism & Swiss Style, calm consumer surface over a data layer that stays out of the way
**Pattern:** Trust & Authority: evidence up front as one ✓ summary, details on demand

## Product principle

Don't make people touch crypto unless they have to. Plain language for every action ("Buy for
100 tUSDC", "Report a problem", "Release payment"). Hashes, addresses, signatures, attestation
quotes and transaction links live behind one collapsed "Verify" / "Details" disclosure per page,
with a visible ✓ summary line. One primary action per screen.

## Color (dark default, light via `prefers-color-scheme`)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0b0e13` | `#f6f7f9` | page |
| `--panel` | `#10141a` | `#ffffff` | raised surface |
| `--panel-2` | `#161b23` | `#f0f2f5` | hover, inset |
| `--border` | `#232a34` | `#e2e6eb` | dividers |
| `--input-border` | `#5b6575` | `#8a94a3` | form controls (≥ 3:1) |
| `--text` | `#e6e9ef` | `#0f1520` | primary text (≥ 15:1) |
| `--muted` | `#9aa3b2` | `#4f5b6b` | secondary text (≥ 6:1) |
| `--faint` | `#7c8696` | `#5f6b7c` | tertiary text (≥ 4.8:1) |
| `--accent` | `#fbbf24` | `#a14a08` | the one accent as text/ring |
| `--accent-fill` | `#f59e0b` | `#f59e0b` | primary button fill, ink `#0b0e13` (≥ 8.5:1) |
| `--ok` / `--warn` / `--bad` / `--info` | `#34d399` `#fb923c` `#f87171` `#60a5fa` | `#047857` `#c2410c` `#b91c1c` `#1d4ed8` | status only (≥ 4.8:1) |

Rejected from the generated output: purple CTA (`#8B5CF6`), gold-plus-purple, glassmorphism,
blur overlays. Amber appears only on the primary button, focus rings and active marks.

## Typography

- **UI:** IBM Plex Sans 400/500/600 (next/font, `--font-plex-sans`)
- **Data:** JetBrains Mono (`--font-jetbrains-mono`) for amounts, counts, hashes and addresses only
- Rejected: Orbitron + Exo 2 (sci-fi cliché for a trust product); tracked all-caps mono eyebrow labels (template tell)
- Scale: 12 (labels) · 13 · 14 (body) · 15 (lead) · 20 · 28 · 40 (home h1). Sentence case everywhere.
- `tabular-nums` on every number that sits in a column or updates live.

## Spacing, shape, depth

- 4px grid. Page sections 48px apart; card padding 16–20px; rows 12–14px vertical.
- Radius 6px (cards, buttons, inputs), 4px (chips). Nothing rounder.
- Depth by 1px borders and surface steps. Shadows only on overlays (menus).

## Motion (3/10)

150ms color/border transitions only. No scroll reveals, no GSAP, no transforms on hover.
`prefers-reduced-motion` disables all animation, including skeleton pulses and spinners.

## Components

Button (primary / default / ghost / sm), Chip (tone + optional dot), PurchaseStateChip, PageHeader,
Card, Stat, Notice, Empty, Skeleton, Details (collapsed verification panel), HashValue / AddressLink /
TxLink (truncate + copy + explorer), Countdown, Stars. See `apps/web/DESIGN.md`.

## Anti-patterns (do not use)

- Gradient blobs, glassmorphism, emoji icons, glow, neon
- Centered marketing layout, feature-card grids, filler stats
- Hashes or wallet jargon in the main flow
- Title Case Buttons, exclamation marks, "seamless / robust / leverage / empower"
- Unclear fees: every amount states what it pays for

## Pre-delivery checklist

- [ ] No emoji icons; one SVG icon family (1.6 stroke, 20px grid)
- [ ] cursor-pointer and a hover state on every clickable element
- [ ] Text ≥ 4.5:1 in both themes (checked, see table)
- [ ] Visible `:focus-visible` ring; sticky header never covers focus (`scroll-margin-top`)
- [ ] `prefers-reduced-motion` respected
- [ ] 375 / 768 / 1024 / 1440 px checked; no horizontal page scroll

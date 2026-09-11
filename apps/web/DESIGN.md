# Design brief: RL Environment Market web app

The product sells sealed RL environments before the buyer can inspect them, so the interface has
one job: make the evidence easy to trust without making anyone read a block explorer. It should
feel like a calm consumer store with an audit trail you can open if you want it.

## Principles

1. **Hide the crypto until someone asks for it.** Actions use plain verbs ("Buy for 100 tUSDC",
   "Report a problem", "Release payment", "Sign in"). Hashes, addresses, signatures, attestation
   quotes, chain names and transaction links live in one collapsed **Details** panel per page. Its
   summary line ("✓ Verified in your browser · report signed, files match the listing") is what
   most people read. Pattern from Phantom and Uniswap's swap flow, which keep routing and calldata
   one click away.
2. **One primary action per screen.** Only one amber button is visible at a time; everything else
   is a default or ghost button. Pattern from Linear and Vercel dashboards.
3. **Color means something.** The whole palette is neutral slate with a single amber accent for the
   primary button, focus ring and active nav mark. Green, orange, red and blue only ever appear in
   status chips and notices, and always next to a word. Pattern from Hyperliquid and Vercel's
   Geist scale (steps for background, border, text).
4. **Borders, not shadows.** Surfaces separate by 1px borders and a one-step background change
   (Linear, Flashbots). Shadows appear only on menus that float over content.
5. **Numbers are data.** Amounts, counts, countdowns and identifiers are set in JetBrains Mono with
   tabular figures, so columns line up and live values don't jitter (Etherscan, Polymarket). Prose
   is IBM Plex Sans.
6. **Honest copy.** Every claim is specific and checkable: the testnet token has no value, a
   signature identifies who produced a report and doesn't prove it's true, and pass@1 doesn't
   predict training gains. All strings follow the no-ai-slop rules (no puffery, no "seamless",
   no binary contrasts, sentence case, no em dashes in short copy).
7. **Restraint in motion.** 150ms color and border transitions only. No scroll reveals and no hover
   lifts. `prefers-reduced-motion` turns off everything, including skeleton pulses.

Rejected on purpose: purple-to-blue gradients, glassmorphism and backdrop blur, emoji icons,
centered hero plus feature-card grids, rounded-2xl cards with drop shadows, filler stats (zero
counters are hidden), and "Welcome to the future of…" copy.

## Tokens

Defined in `src/app/globals.css` (CSS variables mapped into Tailwind v4 `@theme`). Dark is the
default; light applies under `prefers-color-scheme: light`. Contrast was measured, not guessed.

| Token | Dark | Light | Contrast on page bg |
|---|---|---|---|
| `bg` / `panel` / `panel-2` | `#0b0e13` `#10141a` `#161b23` | `#f6f7f9` `#ffffff` `#f0f2f5` | |
| `ink` (text) | `#e6e9ef` | `#0f1520` | 15.9 / 17.1 |
| `muted` | `#9aa3b2` | `#4f5b6b` | 7.6 / 6.4 |
| `faint` | `#7c8696` | `#5f6b7c` | 5.3 / 5.1 |
| `line` / `line-strong` | `#232a34` `#343d4a` | `#e2e6eb` `#c9d0d9` | decorative |
| `input` border | `#5b6575` | `#8a94a3` | ≥ 3:1 (non-text) |
| `accent` (text, ring) | `#fbbf24` | `#a14a08` | 11.6 / 5.6 |
| `accent-fill` + `accent-ink` | `#f59e0b` + `#0b0e13` | same | 9.0 / 8.5 |
| `ok` `warn` `bad` `info` | `#34d399` `#fb923c` `#f87171` `#60a5fa` | `#047857` `#c2410c` `#b91c1c` `#1d4ed8` | all ≥ 4.8 |

- **Type:** Plex Sans 400/500/600, JetBrains Mono; sizes 11 (mono label), 12, 13, 14 (body),
  15 (lead), 18, 28, 40 (home h1). Headings use `text-wrap: balance`.
- **Space:** 4px grid; 16px card padding (20px from `sm`); 48–64px between page sections.
- **Radius:** 6px for cards, buttons and inputs; 4px for chips.
- **Focus:** one 2px `:focus-visible` outline in the accent everywhere; a skip link; `scroll-margin-top`
  clears the sticky header.

## Component inventory (`src/components/ui.tsx` unless noted)

| Component | Use |
|---|---|
| `.btn`, `.btn-primary`, `.btn-sm`, `.btn-ghost` | 36px / 28px targets; primary is the one amber action |
| `Chip`, `PurchaseStateChip`, `Verified` | status as tinted label + optional dot; text carries meaning |
| `Details`, `DetailSection` | the collapsed verification panel with a ✓ / ✗ / pending summary |
| `PageHeader`, `BackLink` | eyebrow, h1, lead, actions, meta row |
| `Card`, `Stat`, `.kv`, `.data-table` | surfaces, key/value lists, dense tables with mono headers |
| `HashValue`, `AddressLink`, `TxLink` | truncated mono + copy (with live "Copied") + explorer link |
| `Countdown`, `Stars`, `Skeleton`, `Notice`, `Empty`, `ErrorText` | time, ratings, loading, messages |
| `VersionRow` (`version-card.tsx`) | browse list row: what you get, price, one verification chip |
| `SiteHeader` / `SiteFooter` (`site-chrome.tsx`) | nav with underline active mark, test-market strip, account menu |

Icons are one hand-drawn family on a 20px grid with a 1.6 stroke, always `aria-hidden`; controls
carry their own labels.

## Pages

- **Browse (`/`)**: one-paragraph pitch, a four-step "how buying works" row, caveat line, and the
  environment list. Totals only appear once there are purchases.
- **Listing**: what you get (tasks, skills, reference-model scores, reviewer's note, seller claims),
  then a sticky price panel with one protection line and the buy button, then one Details panel.
- **Purchase**: progress tracker (Paid → Delivered → Protection window → Complete) and one action for
  the current state; receipts and checks go in Details.
- **Dispute**: plain summary of the claim, a stage tracker, your jury seat as the primary action if you
  hold one; seeds, hashes and addresses go in Details.
- **Account, Jurors, Activity, Delivery keys, How it works**: same primitives, plain labels.

The generated design system from the ui-ux-pro-max skill, with the curation decisions, is in
`design-system/rl-env-market/MASTER.md`. Screenshots are in `docs/screenshots/`.

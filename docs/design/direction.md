# UI/UX overhaul: design direction record

**Status: approved (2026-10-02).** Preset B "Canvas", taken in full with no knob changes.

This file records the visual direction chosen in the design lab (Phase D of the overhaul plan). PR 0 implements the values below. The lab was the visual reference during the overhaul and was removed in PR 11; this record stays.

## Decision

| Knob            | Chosen value     | Notes                                                                                     |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Sans typeface   | Inter Variable   | `@fontsource-variable/inter` replaces `@fontsource-variable/dm-sans`                      |
| Mono typeface   | JetBrains Mono   | Unchanged (`@fontsource/jetbrains-mono` 400 and 500)                                      |
| Default palette | Graphite         | Replaces the `f5-black` values in place (same id, so stored settings keep pointing at it) |
| Accent          | Cobalt (hue 262) | Maps to `primary` and `ring`                                                              |
| Shell           | Canvas           | Sidebar on `chrome`, main view and right panel as raised canvases with an 8px gutter      |
| Density         | Comfortable      | Constant (32px rows, 14px body); no `uiDensity` setting                                   |
| Composer        | Dock             | Floating dock over a bottom fade; timeline padding tracks the measured dock height        |
| Workflow page   | Board            | Phases as columns at `lg` and up; List below `lg`                                         |
| Home            | Dashboard        | Composer-styled quick start, "Needs you" cards with deep-link actions                     |
| Motion          | Expressive       | Panel slide and staggered list entry, always `motion-reduce` safe                         |
| Radius base     | 0.75rem (12px)   | `--radius`                                                                                |

## Final token values

### Typography

- `--font-sans`: `"Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`, with `font-feature-settings: "cv11", "ss01", "ss03"`.
- `--font-mono`: `"JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`.
- `--font-heading`: same as `--font-sans`; headings use `tracking-tight`.
- Weights: 400 body, 500 labels and titles, 600 page headings.

### Default palette (Graphite + Cobalt)

| Token                                                | Light                     | Dark                     |
| ---------------------------------------------------- | ------------------------- | ------------------------ |
| chrome (derived)                                     | `oklch(0.943 0.0015 260)` | `oklch(0.155 0.006 260)` |
| background (canvas)                                  | `oklch(0.993 0.0015 260)` | `oklch(0.192 0.006 260)` |
| card (raised)                                        | `oklch(1 0 0)`            | `oklch(0.222 0.007 260)` |
| popover (overlay)                                    | `oklch(1 0 0)`            | `oklch(0.25 0.008 260)`  |
| foreground, card/popover/secondary/accent-foreground | `oklch(0.21 0.008 260)`   | `oklch(0.95 0.003 260)`  |
| muted-foreground                                     | `oklch(0.5 0.012 260)`    | `oklch(0.69 0.01 260)`   |
| secondary                                            | `oklch(0.962 0.004 260)`  | `oklch(0.255 0.007 260)` |
| muted                                                | `oklch(0.965 0.003 260)`  | `oklch(0.24 0.006 260)`  |
| accent                                               | `oklch(0.948 0.005 260)`  | `oklch(0.275 0.008 260)` |
| border                                               | `oklch(0.905 0.005 260)`  | `oklch(0.295 0.008 260)` |
| input                                                | `oklch(0.865 0.007 260)`  | `oklch(0.34 0.01 260)`   |
| primary                                              | `oklch(0.52 0.2 262)`     | `oklch(0.56 0.2 262)`    |
| primary-foreground                                   | `oklch(0.99 0 0)`         | `oklch(0.99 0 0)`        |
| ring                                                 | `oklch(0.56 0.2 262)`     | `oklch(0.68 0.17 262)`   |

Semantic tokens use the fixed hues (info 250, success 152, warning 75, destructive 27, attention 300) with semantic chroma 0.16 for the default theme; other themes keep the generator's chroma. All `*-foreground` semantic tokens are coloured text on neutral surfaces.

### Derived tokens (every theme, computed after overrides)

- `chrome`: `background` with oklch lightness reduced by 0.05 (light) or 0.037 (dark), same chroma and hue.
- `faint-foreground`: oklab blend from `muted-foreground` toward `background`, the largest blend up to 0.6 that keeps 3:1 against `background`, `card` and `accent`. Non-text only.
- `attention`: light `oklch(0.58 c 300)`, dark `oklch(0.72 c 300)`; `attention-foreground`: light `oklch(0.42 c 300)`, dark `oklch(0.8 0.7c 300)`, where `c` is the theme's semantic chroma.

### Surfaces, radius, density, motion

- `--radius: 0.75rem`. Tiers: `rounded-md` controls and chips, `rounded-lg` rows and cards, `rounded-xl` canvases, composer, dialogs, panels and bubbles, `rounded-full` pills, dots and send.
- Raised surfaces: `bg-card` with a hairline border and a soft shadow (`shadow-xs`/`shadow-sm` scale); canvases: `bg-background rounded-xl` with a hairline and soft shadow on `bg-chrome`.
- Rows: 32px (`h-8`); body text 14px; list text `text-ui` (13px); meta `text-2xs` (11px) minimum.
- Motion: `--duration-fast: 120ms`, `--duration-base: 180ms`, `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`. Right panel slides in 16px; Home and sidebar lists stagger in 28ms steps (max 12). Everything is disabled under `prefers-reduced-motion`.

## Guardrails

- `apps/web/src/designTokens.test.ts` fails on any raw Tailwind palette colour (`text-amber-600`), arbitrary text size (`text-[11px]`), faded text (`text-muted-foreground/70`) or pixel radius (`rounded-[10px]`) in `apps/web/src`. The patterns live in `apps/web/src/designTokenRules.ts`.
- `bun apps/web/scripts/codemod-ui-tokens.ts [--write] <src-relative files>` maps most of them onto the type scale and semantic tokens and reports anything that needs a decision.
- Status colours (F3, `apps/web/src/threadStatus.ts`): `info` working, `success` completed, `warning` pending approval or plan ready (told apart by icon), `attention` awaiting your input, `destructive` errors. Syntax colouring reuses the same tokens so themes recolour it.

## Rejected alternatives

- Preset A "Refined" (DM Sans, F5 Black fixed, Classic shell): safest, but keeps the flat, low-contrast single-plane look the overhaul set out to replace.
- Preset C "Ink" (Geist, near-monochrome, compact, hairline-only): calm, but the monochrome primary weakens the "what do I do next" cue and compact density hurts long sessions.
- Geist and DM Sans: Inter reads best at 11 to 13px and has tabular numerals by default.
- Attached composer: wastes the column bottom; the dock keeps more of the timeline visible.
- List-only workflow page and Inbox Home: kept as the narrow-width fallback (List) and not used (Inbox); Board and Dashboard make per-slot models and next actions visible at a glance.
- Minimal motion: kept implicitly through `prefers-reduced-motion`.

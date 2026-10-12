# Themes and brands

Components only read role tokens (`--color-canvas`, `--color-on-card`, `--color-accent`, `--color-heading`,
`--fill-brand`, …). Two axes set those tokens:

- **Theme** (mode): light, dark, matrix. The reader picks it. It sets everything: canvas, cards, text,
  accents, fonts. Files: `themes/<id>.css`, registry: `themes.ts`.
- **Brand**: a partner's colours, e.g. a chain. It sets only the accent family. Canvas and body text stay
  with the reader's mode, which is what keeps body text readable. Files: `brands/<id>.css`, registry:
  `brands.ts`.

## The accent family

A brand file sets these seven tokens:

| Token | What it is | Checked against (tests/theme-brands.test.ts) |
| --- | --- | --- |
| `--color-accent` | Accent text and marks on the canvas | the canvas, 4.5:1 |
| `--color-accent-ink` | Text on an accent fill (badges, step numbers) | the accent, 4.5:1 |
| `--color-focus` | Focus rings on the canvas | the canvas, 3:1 |
| `--color-accent-on-card` | The accent tuned for cards: links, buttons, focus rings, frames and edges inside a `Receipt` | every card it can sit on, 4.5:1 |
| `--fill-brand` | A band or swatch. Always a `linear-gradient`, never under text | |
| `--fill-hero` | The chain page's hero band (`ChainHero`). Always a `linear-gradient` | |
| `--color-on-hero` | Everything on the hero | every colour the hero fill paints, sampled, 4.5:1 |

`tokens.css` derives the rest from them, with a house default for each so unbranded pages keep their look:

| Token | House look | Brand page |
| --- | --- | --- |
| `--color-heading` | `--color-on-canvas` | `--color-accent` |
| `--color-link` | `currentColor` | `--color-accent` |
| `--color-link-on-card` | `currentColor` | `--color-accent-on-card` |
| `--color-marker` (list bullets) | `--color-on-canvas-muted` | `--color-accent` |
| `--color-focus-on-card` | `--color-focus` | `--color-accent-on-card` |
| `--color-section-rule` | transparent | the accent, mixed toward the canvas |
| `--color-frame-on-card` (QR frame) | transparent | `--color-accent-on-card` |
| `--card-edge-start` | `--card-border` | a thick edge in `--color-accent-on-card` |
| `--color-canvas-rule`, `--color-card-rule` | the mode's | mixed toward the accent |
| `--color-house-accent`, `--color-house-accent-ink` | the mode's accent | unchanged: a brand never sets them |

A `Receipt` re-points `--color-link` and `--color-focus` at their `-on-card` versions, so anything inside a
card picks up the card-safe colour with no props.

## Add a theme

1. Copy `themes/light.css` to `themes/<id>.css` and change the values. Set every token the others set.
   Use the selector `[data-theme="<id>"]`.
2. Add `{ id: "<id>", label: "<Label>" }` to `THEMES` in `themes.ts`.
3. Add `@import "../ui/theme/themes/<id>.css";` to `src/app/globals.css`.

The theme picker lists it from then on. The contrast test runs every brand against it.

## Add a brand

1. Copy `brands/base.css` to `brands/<id>.css`. Keep its three blocks, in this order:
   - `[data-brand="<id>"]`: every token. These are the dark-mode values and the default.
   - `[data-theme="matrix"] [data-brand="<id>"], [data-theme="matrix"][data-brand="<id>"]`: what differs in
     matrix. Matrix cards are dark, so at least `--color-accent-on-card` (dark-mode cards are paper).
   - `[data-theme="light"] [data-brand="<id>"], [data-theme="light"][data-brand="<id>"]`: what differs in
     light. Light comes last so a light scope inside a matrix page still gets it; set
     `--color-accent-on-card` here too.

   Set only the seven accent-family tokens.
2. Add `{ id: "<id>", label: "<Label>" }` to `BRANDS` in `brands.ts`.
3. Add `@import "./<id>.css";` to `brands/index.css`.
4. Run `pnpm exec vitest run tests/theme-brands.test.ts`. It fails until every pair in the table above
   passes in every mode, the hero text reads on every part of the hero fill, and the accent and the mode's
   muted text read on a chain tile's hover tint. Darken the light variant or lighten the dark one until it
   passes.

## Use them

```tsx
import { ThemeScope } from "@/ui/theme/ThemeScope";

<ThemeScope brand="solana">…</ThemeScope>                         // a tile or swatch: Solana accents only
<ThemeScope brand="base" extent="page" backdrop="off">…</ThemeScope> // a brand page, no matrix rain
<ThemeScope theme="light">…</ThemeScope>                          // light for this subtree only
```

`extent="page"` is for a page that belongs to the brand (the chain pages). The brand then also takes the
headings, links, list markers, rules, buttons, card edges and the hero, and in matrix the phosphor green
goes: text turns a neutral light, panels lose their green tint and the glow takes the brand's accent
(`themes/matrix.css`), while the terminal font stays. Keep the site header and footer outside the scope so
they stay in the house theme.

Without `extent` a brand scope recolours only what reads the accent tokens directly, which is what a
`ChainStrip` tile wants: its logo, band and badge, and its hover glow, tint and cue. A tile that should keep
the house look at rest reads `--color-house-accent` for those, and switches to the brand on hover.

Scopes nest: an inner scope wins for its subtree. A brand picks its light variant when the page, or any
scope around it (or the brand scope itself), is light, its matrix variant when matrix is, and its default
otherwise. So a dark or matrix scope inside a light page still gets the light brand variant; brand pages
that need that should set the mode on the page instead.

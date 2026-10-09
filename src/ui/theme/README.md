# Themes and brands

Components only read role tokens (`--color-canvas`, `--color-on-card`, `--color-accent`, `--fill-brand`, …).
Two axes set those tokens:

- **Theme** (mode): light, dark, matrix. The reader picks it. It sets everything: canvas, cards, text,
  accents, fonts. Files: `themes/<id>.css`, registry: `themes.ts`.
- **Brand**: a partner's colours, e.g. a chain. It sets only the accent family: `--color-accent`,
  `--color-accent-ink`, `--color-focus` and `--fill-brand`. Canvas and text always stay with the reader's
  mode, which is what keeps body text readable. Files: `brands/<id>.css`, registry: `brands.ts`.

## Add a theme

1. Copy `themes/light.css` to `themes/<id>.css` and change the values. Set every token the others set.
   Use the selector `[data-theme="<id>"]`.
2. Add `{ id: "<id>", label: "<Label>" }` to `THEMES` in `themes.ts`.
3. Add `@import "../ui/theme/themes/<id>.css";` to `src/app/globals.css`.

The theme picker lists it from then on.

## Add a brand

1. Copy `brands/base.css` to `brands/<id>.css`. Keep its two blocks:
   - `[data-brand="<id>"]`: the dark variant, used in dark and matrix.
   - `[data-theme="light"] [data-brand="<id>"], [data-theme="light"][data-brand="<id>"]`: the light variant.

   Set only the four accent-family tokens. `--fill-brand` is always an image, so it works as a
   `background-image`: a gradient, or `linear-gradient(c, c)` for one colour. It is only ever a fill, never under text.
2. Add `{ id: "<id>", label: "<Label>" }` to `BRANDS` in `brands.ts`.
3. Add `@import "./<id>.css";` to `brands/index.css`.
4. Run `pnpm exec vitest run tests/theme-brands.test.ts`. It fails until the accent reads as text on
   every mode's canvas (4.5:1), the ink reads on the accent (4.5:1) and the focus ring shows (3:1).
   Darken the light variant or lighten the dark one until it passes.

## Use them

```tsx
import { ThemeScope } from "@/ui/theme/ThemeScope";

<ThemeScope brand="solana">…</ThemeScope>            // Solana accents, the reader's mode
<ThemeScope theme="light">…</ThemeScope>             // light for this subtree only
<ThemeScope brand="base" backdrop="off">…</ThemeScope> // and no matrix rain on this page
```

Scopes nest: an inner scope wins for its subtree. A brand picks its light variant when the page, or any
scope around it (or the brand scope itself), is light, and its dark variant otherwise. So a dark or matrix
scope inside a light page still gets the light brand variant; brand pages that need that should set the mode
on the page instead.

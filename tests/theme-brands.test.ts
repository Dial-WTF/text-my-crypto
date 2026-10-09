import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHAINS } from "@/lib/chains";
import { BRANDS, isBrandId } from "@/ui/theme/brands";
import { ThemeScope } from "@/ui/theme/ThemeScope";
import { THEMES, type ThemeId } from "@/ui/theme/themes";

const THEME_DIR = join(__dirname, "..", "src", "ui", "theme");
const read = (...parts: string[]) => readFileSync(join(THEME_DIR, ...parts), "utf8");

type Rgb = [number, number, number];

/** oklch("84% 0.17 165") → linear sRGB, clamped to the gamut. */
function oklchToLinear(value: string): Rgb {
  const [l, c, h] = value.trim().split(/\s+/).map((p) => parseFloat(p));
  const L = (l ?? 0) / 100;
  const hr = ((h ?? 0) * Math.PI) / 180;
  const a = (c ?? 0) * Math.cos(hr);
  const b = (c ?? 0) * Math.sin(hr);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

const toGamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const gamma = (c: Rgb): Rgb => [toGamma(c[0]), toGamma(c[1]), toGamma(c[2])];
const linear = (c: Rgb): Rgb => [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])];

/** `top` at `alpha` over `bottom`, blended the way browsers do: in gamma-encoded sRGB. */
function over(top: string, alpha: number, bottom: string): Rgb {
  const [t, b] = [gamma(oklchToLinear(top)), gamma(oklchToLinear(bottom))];
  return linear([0, 1, 2].map((i) => (t[i] ?? 0) * alpha + (b[i] ?? 0) * (1 - alpha)) as Rgb);
}

/** WCAG contrast ratio between two colours: oklch strings or linear sRGB. */
function contrast(x: string | Rgb, y: string | Rgb): number {
  const lum = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const rgb = (c: string | Rgb) => (typeof c === "string" ? oklchToLinear(c) : c);
  const [a, b] = [lum(rgb(x)), lum(rgb(y))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every colour a linear-gradient paints, sampled the way CSS interpolates by default (gamma sRGB). */
function gradientSamples(fill: string): Rgb[] {
  const stops = [...fill.matchAll(/oklch\(([^)/]+)\)/g)].map((m) => gamma(oklchToLinear(m[1] ?? "")));
  const out: Rgb[] = [];
  for (let i = 0; i < stops.length; i++) {
    const [a, b] = [stops[i], stops[i + 1] ?? stops[i]];
    if (!a || !b) continue;
    for (let t = 0; t <= 1; t += 0.05) out.push(linear([0, 1, 2].map((k) => (a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * t) as Rgb));
  }
  return out;
}

/** The declarations of a block of CSS: `--name` → value. */
function declarations(body: string): Map<string, string> {
  return new Map([...body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

/** The oklch(...) channels of a colour token's value. */
function channels(value: string | undefined, what: string): string {
  const m = /^oklch\(([^)/]+)/.exec(value ?? "");
  if (!m?.[1]) throw new Error(`${what} is not an oklch colour: ${value ?? "(missing)"}`);
  return m[1].trim();
}

/** The oklch channels of `name`'s first declaration in a theme file (the theme's own block); alpha dropped. */
function themeToken(file: string, name: string): string {
  const m = new RegExp(`${name}:\\s*oklch\\(([^)/]+)`).exec(read("themes", file));
  if (!m?.[1]) throw new Error(`${name} missing from ${file}`);
  return m[1].trim();
}

/** A brand file's blocks: the default (dark mode), then matrix and light overrides. */
function brandBlocks(id: string): Record<ThemeId, Map<string, string>> & { files: string } {
  const css = read("brands", `${id}.css`);
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1] ?? "", body: m[2] ?? "" }));
  const pick = (mode: string) => blocks.filter((b) => b.selector.includes(`[data-theme="${mode}"]`));
  const base = blocks.filter((b) => !b.selector.includes("data-theme"));
  expect(base, `${id}.css default block`).toHaveLength(1);
  expect(pick("matrix"), `${id}.css matrix block`).toHaveLength(1);
  expect(pick("light"), `${id}.css light block`).toHaveLength(1);
  const dark = declarations(base[0]?.body ?? "");
  const merged = (mode: string) => new Map([...dark, ...declarations(pick(mode)[0]?.body ?? "")]);
  return { dark, matrix: merged("matrix"), light: merged("light"), files: css };
}

/** What a mode paints under brand colours: the canvas, and the cards on a brand page. */
const MATRIX_BRAND_PAGE = (() => {
  const css = read("themes", "matrix.css");
  const at = css.indexOf('[data-brand-extent="page"]');
  expect(at, "matrix.css has a brand page block").toBeGreaterThan(0);
  return declarations(css.slice(at));
})();

const surfaces: Record<ThemeId, { canvas: string; cards: string[]; muted: string }> = {
  dark: {
    canvas: themeToken("dark.css", "--color-canvas"),
    cards: [themeToken("dark.css", "--color-card")],
    muted: themeToken("dark.css", "--color-on-canvas-muted"),
  },
  matrix: {
    canvas: themeToken("matrix.css", "--color-canvas"),
    // A brand scope with no page extent keeps the matrix panels; a brand page swaps them for neutral ones.
    cards: [themeToken("matrix.css", "--color-card"), channels(MATRIX_BRAND_PAGE.get("--color-card"), "matrix brand card")],
    muted: themeToken("matrix.css", "--color-on-canvas-muted"),
  },
  light: {
    canvas: themeToken("light.css", "--color-canvas"),
    cards: [themeToken("light.css", "--color-card")],
    muted: themeToken("light.css", "--color-on-canvas-muted"),
  },
};

const BRAND_TOKENS = [
  "--color-accent",
  "--color-accent-ink",
  "--color-focus",
  "--color-accent-on-card",
  "--fill-brand",
  "--fill-hero",
  "--color-on-hero",
];

/** The strongest part of a chain tile's hover tint (ChainStrip): the accent at this alpha over the canvas. */
const TILE_TINT = 0.14;

describe("brand registry", () => {
  it("has a brand for every chain, so a chain page can pass its chain id", () => {
    for (const chain of CHAINS) expect(isBrandId(chain), chain).toBe(true);
  });

  it("has one CSS file per brand, imported once, and no unregistered files", () => {
    const files = readdirSync(join(THEME_DIR, "brands")).filter((f) => f.endsWith(".css") && f !== "index.css");
    expect(files.map((f) => f.replace(/\.css$/, "")).sort()).toEqual(BRANDS.map((b) => b.id).sort());
    const index = read("brands", "index.css");
    for (const b of BRANDS) expect(index).toContain(`@import "./${b.id}.css";`);
    expect(read("..", "..", "app", "globals.css")).toContain('@import "../ui/theme/brands/index.css";');
  });

  it("sets only accent-family tokens, so canvas and text stay with the reader's mode", () => {
    for (const b of BRANDS) {
      const names = [...read("brands", `${b.id}.css`).matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
      expect(new Set(names), b.id).toEqual(new Set(BRAND_TOKENS));
      // Images, so they work as a background-image (ChainStrip's band, ChainHero's band) as well as a background.
      for (const m of read("brands", `${b.id}.css`).matchAll(/--fill-(?:brand|hero):\s*([^;]+);/g)) {
        expect(m[1], b.id).toMatch(/^linear-gradient\(/);
      }
    }
  });

  it("gives every derived accent role a house default and points it at the brand on a brand page", () => {
    const tokens = read("tokens.css");
    const house = declarations(tokens.slice(tokens.indexOf(":root,\n[data-theme] {"), tokens.indexOf('[data-brand-extent="page"] {')));
    const page = declarations(tokens.slice(tokens.indexOf('[data-brand-extent="page"] {')));
    for (const name of ["--fill-brand", "--fill-hero", "--color-on-hero", "--color-accent-on-card", "--color-house-accent"]) {
      expect(house.has(name), name).toBe(true);
    }
    for (const [name, value] of page) {
      if (name.startsWith("--color-canvas-rule") || name.startsWith("--color-card-rule")) continue;
      expect(house.has(name), `${name} has a house default`).toBe(true);
      expect(value, name).toMatch(/var\(--color-accent/);
    }
  });
});

describe("brand contrast (WCAG AA)", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrast("100% 0 0", "0% 0 0")).toBeCloseTo(21, 1);
    expect(contrast("50% 0 0", "50% 0 0")).toBeCloseTo(1, 5);
    // The house green is a fill, not text, on the light canvas: it must read as failing here.
    expect(contrast(themeToken("dark.css", "--color-accent"), surfaces.light.canvas)).toBeLessThan(3);
    // Red to green dips below both ends when blended in gamma sRGB, which is why gradients are sampled.
    const dip = gradientSamples("linear-gradient(oklch(62.8% 0.2577 29.23), oklch(86.6% 0.2948 142.5))");
    const lums = dip.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
    expect(Math.min(...lums)).toBeLessThan(Math.min(lums[0] ?? 0, lums.at(-1) ?? 0));
  });

  for (const b of BRANDS) {
    for (const { id: mode } of THEMES) {
      it(`${b.id} in ${mode}: accent, ink, focus, card accent, hero text and tile hover all pass`, () => {
        const tokens = brandBlocks(b.id)[mode];
        const color = (name: string) => channels(tokens.get(name), `${b.id} ${name} (${mode})`);
        const { canvas, cards, muted } = surfaces[mode];
        const accent = color("--color-accent");

        expect(contrast(accent, canvas), `${b.id} accent on ${mode} canvas`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color("--color-accent-ink"), accent), `${b.id} ink on accent (${mode})`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color("--color-focus"), canvas), `${b.id} focus ring on ${mode} canvas`).toBeGreaterThanOrEqual(3);

        // Links, buttons (both ways: ink on card, card on ink), focus rings and frames on a card.
        for (const card of cards) {
          expect(contrast(color("--color-accent-on-card"), card), `${b.id} accent on ${mode} card ${card}`).toBeGreaterThanOrEqual(4.5);
        }

        // The hero: its text on every colour its fill paints.
        const hero = tokens.get("--fill-hero") ?? "";
        const samples = gradientSamples(hero);
        expect(samples.length, `${b.id} hero fill has colours`).toBeGreaterThan(0);
        const onHero = color("--color-on-hero");
        const worst = Math.min(...samples.map((s) => contrast(onHero, s)));
        expect(worst, `${b.id} hero text on its fill (${mode})`).toBeGreaterThanOrEqual(4.5);

        // A chain tile on hover: its name and cue in the accent, and its role in the mode's muted text,
        // on the strongest part of the tint.
        const tint = over(accent, TILE_TINT, canvas);
        expect(contrast(accent, tint), `${b.id} accent on hover tint (${mode})`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(muted, tint), `${b.id} muted text on hover tint (${mode})`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("a matrix brand page's neutral text reads on the canvas and on its panels", () => {
    const canvas = surfaces.matrix.canvas;
    const card = channels(MATRIX_BRAND_PAGE.get("--color-card"), "card");
    for (const name of ["--color-on-canvas", "--color-on-canvas-muted"]) {
      expect(contrast(channels(MATRIX_BRAND_PAGE.get(name), name), canvas), name).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ["--color-on-card", "--color-on-card-muted"]) {
      expect(contrast(channels(MATRIX_BRAND_PAGE.get(name), name), card), name).toBeGreaterThanOrEqual(4.5);
    }
    // The glow follows the brand, not the phosphor green.
    expect(MATRIX_BRAND_PAGE.get("--text-glow")).toContain("var(--color-accent)");
  });

  it("the tile tint in ChainStrip is the one the test checks", () => {
    const css = readFileSync(join(__dirname, "..", "src", "ui", "patterns", "ChainStrip", "ChainStrip.module.css"), "utf8");
    const tint = /\.linked::before \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const strengths = [...tint.matchAll(/color-mix\(in oklab, var\(--color-accent\) (\d+)%, transparent\)/g)].map((m) => Number(m[1]));
    expect(strengths.length).toBeGreaterThan(0);
    expect(Math.max(...strengths) / 100).toBeLessThanOrEqual(TILE_TINT);
  });
});

describe("ThemeScope", () => {
  it("nests: an inner brand scope sits inside an outer mode scope that overrides the page", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeScope, { theme: "light" }, createElement(ThemeScope, { brand: "base", backdrop: "off" }, "hi")),
    );
    expect(html).toMatch(/^<div[^>]*data-theme="light"[^>]*><div[^>]*data-brand="base"[^>]*data-backdrop="off"[^>]*>hi<\/div><\/div>$/);
    // The inner scope sets no mode of its own, so it keeps the outer one's canvas and text.
    expect(html.match(/data-theme=/g)).toHaveLength(1);
  });

  it("marks a brand page so the brand takes its headings, links and rules; a tile stays a tile", () => {
    const page = renderToStaticMarkup(createElement(ThemeScope, { brand: "solana", extent: "page" }, "hi"));
    expect(page).toContain('data-brand-extent="page"');
    const tile = renderToStaticMarkup(createElement(ThemeScope, { brand: "solana" }, "hi"));
    expect(tile).not.toContain("data-brand-extent");
  });

  it("brand rules key off the nearest light or matrix scope as well as the page", () => {
    for (const b of BRANDS) {
      const css = read("brands", `${b.id}.css`);
      for (const mode of ["light", "matrix"]) {
        expect(css).toContain(`[data-theme="${mode}"] [data-brand="${b.id}"]`);
        expect(css).toContain(`[data-theme="${mode}"][data-brand="${b.id}"]`);
      }
      // Light comes last, so a light scope inside a matrix page still gets the light variant.
      expect(css.indexOf('[data-theme="light"]')).toBeGreaterThan(css.indexOf('[data-theme="matrix"]'));
    }
  });
});

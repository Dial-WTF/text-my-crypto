import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHAINS } from "@/lib/chains";
import { BRANDS, isBrandId } from "@/ui/theme/brands";
import { ThemeScope } from "@/ui/theme/ThemeScope";

const THEME_DIR = join(__dirname, "..", "src", "ui", "theme");
const read = (...parts: string[]) => readFileSync(join(THEME_DIR, ...parts), "utf8");

/** oklch("84% 0.17 165") → linear sRGB, clamped to the gamut. */
function oklchToLinear(value: string): [number, number, number] {
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

/** WCAG contrast ratio between two oklch colours. */
function contrast(x: string, y: string): number {
  const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [a, b] = [lum(oklchToLinear(x)), lum(oklchToLinear(y))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The oklch(...) value of `token` in a block of CSS. */
function token(css: string, name: string): string {
  const m = new RegExp(`${name}:\\s*oklch\\(([^)/]+)\\)`).exec(css);
  if (!m?.[1]) throw new Error(`${name} missing`);
  return m[1];
}

/** A brand file's two blocks: dark (also matrix) first, light second. */
function brandBlocks(id: string): { dark: string; light: string } {
  const css = read("brands", `${id}.css`);
  const at = css.indexOf('[data-theme="light"]');
  expect(at, `${id}.css has no light variant`).toBeGreaterThan(0);
  return { dark: css.slice(0, at), light: css.slice(at) };
}

const canvas = {
  dark: token(read("themes", "dark.css"), "--color-canvas"),
  matrix: token(read("themes", "matrix.css"), "--color-canvas"),
  light: token(read("themes", "light.css"), "--color-canvas"),
};

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
      expect(new Set(names), b.id).toEqual(new Set(["--color-accent", "--color-accent-ink", "--color-focus", "--fill-brand"]));
      // An image, so it works as a background-image (ChainStrip's band) as well as a background.
      for (const m of read("brands", `${b.id}.css`).matchAll(/--fill-brand:\s*([^;]+);/g)) {
        expect(m[1], b.id).toMatch(/^linear-gradient\(/);
      }
    }
  });
});

describe("brand contrast (WCAG AA)", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrast("100% 0 0", "0% 0 0")).toBeCloseTo(21, 1);
    expect(contrast("50% 0 0", "50% 0 0")).toBeCloseTo(1, 5);
    // The house green is a fill, not text, on the light canvas: it must read as failing here.
    expect(contrast(token(read("themes", "dark.css"), "--color-accent"), canvas.light)).toBeLessThan(3);
  });

  for (const b of BRANDS) {
    it(`${b.id}: accent text on the canvas and ink on the accent pass in every mode`, () => {
      const { dark, light } = brandBlocks(b.id);
      const modes = [
        ["dark", dark, canvas.dark],
        ["matrix", dark, canvas.matrix],
        ["light", light, canvas.light],
      ] as const;
      for (const [mode, block, bg] of modes) {
        const accent = token(block, "--color-accent");
        expect(contrast(accent, bg), `${b.id} accent on ${mode} canvas`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(block, "--color-accent-ink"), accent), `${b.id} ink on accent (${mode})`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(block, "--color-focus"), bg), `${b.id} focus ring on ${mode} canvas`).toBeGreaterThanOrEqual(3);
      }
    });
  }
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

  it("brand rules key off the nearest light scope as well as the page", () => {
    for (const b of BRANDS) {
      const css = read("brands", `${b.id}.css`);
      expect(css).toContain(`[data-theme="light"] [data-brand="${b.id}"]`);
      expect(css).toContain(`[data-theme="light"][data-brand="${b.id}"]`);
    }
  });
});

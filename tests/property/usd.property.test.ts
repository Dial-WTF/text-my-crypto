import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatUsd, isUsdAmount, usdToBaseUnits } from "@/lib/money";

/** Whole cents from $0.00 to $9,999,999.99, the most the grammar accepts. */
const cents = fc.bigInt({ min: 0n, max: 999_999_999n });
const BASE_PER_CENT = 10_000n;

/** "$12.30" → "12.30"; formatUsd drops ".00", so put it back for the comparison of cents. */
const typed = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;

describe("usd parsing and formatting", () => {
  it("parses what it formats: formatUsd(x) without the $ parses back to x", () => {
    fc.assert(
      fc.property(cents, (c) => {
        const base = c * BASE_PER_CENT;
        const shown = formatUsd(base);
        expect(shown.startsWith("$")).toBe(true);
        expect(isUsdAmount(shown.slice(1))).toBe(true);
        expect(usdToBaseUnits(shown.slice(1))).toBe(base);
      }),
    );
  });

  it("formats what it parses: one or two decimals, or none, all mean the same cents", () => {
    fc.assert(
      fc.property(cents, (c) => {
        const base = c * BASE_PER_CENT;
        expect(usdToBaseUnits(typed(c))).toBe(base);
        if (c % 10n === 0n) expect(usdToBaseUnits(`${c / 100n}.${(c % 100n) / 10n}`)).toBe(base);
        if (c % 100n === 0n) expect(usdToBaseUnits(`${c / 100n}`)).toBe(base);
        expect(formatUsd(usdToBaseUnits(typed(c)))).toBe(c % 100n === 0n ? `$${c / 100n}` : `$${typed(c)}`);
      }),
    );
  });

  it("ignores surrounding whitespace", () => {
    fc.assert(
      fc.property(cents, fc.stringMatching(/^\s{0,3}$/), fc.stringMatching(/^\s{0,3}$/), (c, before, after) => {
        expect(usdToBaseUnits(`${before}${typed(c)}${after}`)).toBe(c * BASE_PER_CENT);
      }),
    );
  });

  it("never parses sub-cent precision, more than 7 dollar digits, signs or exponents", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.nat(9_999_999), fc.stringMatching(/^\d{3,6}$/)).map(([d, frac]) => `${d}.${frac}`),
          fc.bigInt({ min: 10_000_000n, max: 10n ** 12n }).map(String),
          fc.nat(9_999_999).map((d) => `-${d}`),
          fc.nat(9_999_999).map((d) => `${d}e2`),
          fc.nat(9_999_999).map((d) => `${d}.`),
        ),
        (s) => {
          expect(isUsdAmount(s)).toBe(false);
          expect(() => usdToBaseUnits(s)).toThrow(RangeError);
        },
      ),
    );
  });

  it("agrees with itself on any string: isUsdAmount is exactly when usdToBaseUnits doesn't throw", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^[\d.\s$-]{0,12}$/)), (s) => {
        if (isUsdAmount(s)) expect(usdToBaseUnits(s)).toBeGreaterThanOrEqual(0n);
        else expect(() => usdToBaseUnits(s)).toThrow(RangeError);
      }),
    );
  });

  it("formats any base-unit amount as dollars and at most two decimals, truncating sub-cent dust", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 16n }), (base) => {
        const shown = formatUsd(base);
        expect(shown).toMatch(/^\$\d+(?:\.\d{2})?$/);
        if (base < 10n ** 13n) expect(usdToBaseUnits(shown.slice(1))).toBe((base / BASE_PER_CENT) * BASE_PER_CENT);
      }),
    );
  });
});

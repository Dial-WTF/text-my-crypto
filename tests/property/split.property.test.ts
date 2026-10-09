import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SPLIT_PEOPLE, splitShares } from "@/lib/bot/split";

const CENT = 10_000n;
/** Whole cents, $0.01 to $9,999,999.99. */
const total = fc.bigInt({ min: 1n, max: 999_999_999n }).map((c) => c * CENT);
/** Everyone listed plus, when "with me", the sender. */
const ways = fc.integer({ min: 1, max: MAX_SPLIT_PEOPLE + 1 });

describe("splitShares", () => {
  it("shares always add up to the total, to the cent", () => {
    fc.assert(
      fc.property(total, ways, (t, n) => {
        const shares = splitShares(t, n);
        if (shares === null) return;
        expect(shares).toHaveLength(n);
        expect(shares.reduce((a, b) => a + b, 0n)).toBe(t);
      }),
    );
  });

  it("everyone gets the same whole-cent share, and the leftover cents go to the first person", () => {
    fc.assert(
      fc.property(total, ways, (t, n) => {
        const shares = splitShares(t, n);
        if (shares === null) return;
        const [first, ...rest] = shares;
        const each = t / CENT / BigInt(n);
        for (const s of rest) expect(s).toBe(each * CENT);
        expect(first).toBe((each + ((t / CENT) % BigInt(n))) * CENT);
        for (const s of shares) expect(s % CENT).toBe(0n);
      }),
    );
  });

  it("the first share is never more than n-1 cents above the others", () => {
    fc.assert(
      fc.property(total, ways, (t, n) => {
        const shares = splitShares(t, n);
        if (shares === null || n === 1) return;
        const gap = (shares[0] ?? 0n) - (shares[1] ?? 0n);
        expect(gap).toBeGreaterThanOrEqual(0n);
        expect(gap).toBeLessThan(BigInt(n) * CENT);
      }),
    );
  });

  it("refuses exactly when someone's share would be under a cent", () => {
    fc.assert(
      fc.property(total, ways, (t, n) => {
        expect(splitShares(t, n) === null).toBe(t / CENT < BigInt(n));
      }),
    );
  });

  it("refuses zero or negative ways", () => {
    fc.assert(
      fc.property(total, fc.integer({ min: -5, max: 0 }), (t, n) => {
        expect(splitShares(t, n)).toBeNull();
      }),
    );
  });
});

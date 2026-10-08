import { describe, expect, it } from "vitest";
import { formatUsd, isUsdAmount, usdToBaseUnits } from "@/lib/money";

describe("money", () => {
  it.each([
    ["10", 10_000_000n],
    ["10.5", 10_500_000n],
    ["0.01", 10_000n],
    ["1234567.99", 1_234_567_990_000n],
  ])("usdToBaseUnits(%s)", (input, expected) => {
    expect(usdToBaseUnits(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "-5", "1e3", "12345678"])("rejects %s", (bad) => {
    expect(isUsdAmount(bad)).toBe(false);
    expect(() => usdToBaseUnits(bad)).toThrow(RangeError);
  });

  it("formats whole and fractional dollars", () => {
    expect(formatUsd(10_000_000n)).toBe("$10");
    expect(formatUsd(10_500_000n)).toBe("$10.50");
    expect(formatUsd(0n)).toBe("$0");
  });
});

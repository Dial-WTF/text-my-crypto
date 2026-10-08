import { describe, expect, it } from "vitest";
import { formatPhone, normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it.each([
    ["8066071387", "+18066071387"],
    ["(806) 607-1387", "+18066071387"],
    ["1 806 607 1387", "+18066071387"],
    ["+1 806-607-1387", "+18066071387"],
    ["+447700900123", "+447700900123"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["jeremy", "12345", "+12"])("rejects %s", (bad) => {
    expect(normalizePhone(bad)).toBeNull();
  });
});

describe("formatPhone", () => {
  it("spaces NANP numbers and leaves others alone", () => {
    expect(formatPhone("+18066071387")).toBe("+1 806 607 1387");
    expect(formatPhone("+447700900123")).toBe("+447700900123");
  });
});

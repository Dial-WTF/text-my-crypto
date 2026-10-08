import { describe, expect, it } from "vitest";
import { initialTheme, parseThemeChoice } from "@/ui/theme/themes";

describe("theme registry", () => {
  it("defaults first-time visitors to matrix", () => {
    expect(parseThemeChoice(undefined)).toBe("matrix");
    expect(parseThemeChoice("nonsense")).toBe("matrix");
    expect(initialTheme(parseThemeChoice(undefined))).toBe("matrix");
  });

  it("keeps an explicit choice", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("system")).toBe("system");
  });
});

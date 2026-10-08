import { describe, expect, it } from "vitest";
import { cleanDisplayName, handleFromName } from "@/lib/names";

describe("cleanDisplayName", () => {
  it.each([
    ["J. P. Meyer, Crypto Anartist Imperialist and Bank Robber lmao", "J. P. Meyer"],
    ["J. P. Meyer", "J. P. Meyer"],
    ["  alex  ", "alex"],
    ["Zoë Ångström", "Zoë Ångström"],
    ["it's me, mario", "it's me"],
    ["@jeremy", "jeremy"],
    ["Dr.  Strange\tLove", "Dr. Strange Love"],
    ["Sam\nI work in finance", "Sam"],
  ])("%s → %s", (raw, expected) => {
    expect(cleanDisplayName(raw)).toBe(expected);
  });

  it("caps long names at a word boundary", () => {
    const n = cleanDisplayName("Bartholomew Montgomery Fitzgerald Worthington the Third");
    expect(n?.length).toBeLessThanOrEqual(40);
    expect(n).toBe("Bartholomew Montgomery Fitzgerald");
  });

  it.each(["", "   ", "!!!", ",,,", "🙂🙂"])("rejects %j", (raw) => {
    expect(cleanDisplayName(raw)).toBeNull();
  });
});

describe("handleFromName", () => {
  it.each([
    ["J. P. Meyer", "jpmeyer"],
    ["Zoë Ångström", "zoeangstrom"],
    ["alex", "alex"],
    ["007 Bond", "d007bond"],
    ["Bartholomew Montgomery Fitzgerald", "bartholomewmontgome"],
  ])("%s → %s", (name, expected) => {
    expect(handleFromName(name)).toBe(expected);
  });

  it("returns null when too short to be a handle", () => {
    expect(handleFromName("Al")).toBeNull();
    expect(handleFromName("李")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { parseCommand, parsePeople } from "@/lib/operator/grammar";

describe("parseCommand: split", () => {
  it.each([
    ["split $30 between @a @b @c", { kind: "split", amountUsd: "30", people: ["@a", "@b", "@c"], includeMe: false }],
    ["split $30 among @a and @b", { kind: "split", amountUsd: "30", people: ["@a", "@b"], includeMe: false }],
    ["Split 30 bucks with @A @b", { kind: "split", amountUsd: "30", people: ["@a", "@b"], includeMe: true }],
    ["split $30 between me and @a", { kind: "split", amountUsd: "30", people: ["@a"], includeMe: true }],
    ["split $30 between alex bob carol", { kind: "split", amountUsd: "30", people: ["alex", "bob", "carol"], includeMe: false }],
    [
      "split $45.50 between alex, my brother jake and +1 555 123 4567 for dinner on tempo",
      {
        kind: "split",
        amountUsd: "45.50",
        people: ["alex", "my brother jake", "+1 555 123 4567"],
        includeMe: false,
        note: "dinner",
        chain: "tempo",
      },
    ],
    [
      "split $30 between (555) 111-2222, +15553334444",
      { kind: "split", amountUsd: "30", people: ["(555) 111-2222", "+15553334444"], includeMe: false },
    ],
    ["split $30 between @a @b on solana", { kind: "split", amountUsd: "30", people: ["@a", "@b"], includeMe: false, chain: "solana" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it.each(["split $30 between $5", "split $10.123 between @a @b", "split $30 with sam on moon", "split $30", "split the bill"])(
    "%s is not a split",
    (text) => {
      expect(parseCommand(text)).toEqual({ kind: "chat" });
    },
  );

  it("drops repeats and keeps the order people were listed in", () => {
    expect(parsePeople("@b @a @b")).toEqual({ people: ["@b", "@a"], includeMe: false });
  });

  it("doesn't take a note or chain as a person", () => {
    expect(parseCommand("split $12 with @a for pizza")).toEqual({
      kind: "split",
      amountUsd: "12",
      people: ["@a"],
      includeMe: true,
      note: "pizza",
    });
  });
});

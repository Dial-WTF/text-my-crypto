import { describe, expect, it } from "vitest";
import { parseCommand } from "@/lib/operator/grammar";

describe("parseCommand", () => {
  it.each([
    ["send jeremy $10", { kind: "send", recipient: "jeremy", amountUsd: "10" }],
    ["Send Jeremy 10", { kind: "send", recipient: "jeremy", amountUsd: "10" }],
    ["pay @jeremy $10.50", { kind: "send", recipient: "jeremy", amountUsd: "10.50" }],
    ["send $5 to alex", { kind: "send", recipient: "alex", amountUsd: "5" }],
    ["send 5 bucks to alex", { kind: "send", recipient: "alex", amountUsd: "5" }],
    ["send jeremy $10 on sol", { kind: "send", recipient: "jeremy", amountUsd: "10", chain: "solana" }],
    ["send $10 to jeremy on tempo", { kind: "send", recipient: "jeremy", amountUsd: "10", chain: "tempo" }],
    ["send +1 806 607 1387 $5", { kind: "send", recipient: "+1 806 607 1387", amountUsd: "5" }],
    ["send $5 to (806) 607-1387", { kind: "send", recipient: "(806) 607-1387", amountUsd: "5" }],
    ["give jeremy 20 usdc", { kind: "send", recipient: "jeremy", amountUsd: "20" }],
    ["  send   jeremy   $10!  ", { kind: "send", recipient: "jeremy", amountUsd: "10" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it.each(["balance", "Balance?", "bal"])("%s → balance", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "balance" });
  });

  it.each(["help", "?", "commands"])("%s → help", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "help" });
  });

  it.each([
    "hi",
    "can you send my buddy jeremy ten dollars",
    "send jeremy $10 on dogecoin",
    "send jeremy $1.234",
    "what is this",
  ])("%s → chat (LLM handles it)", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "chat" });
  });
});

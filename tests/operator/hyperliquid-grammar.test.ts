import { describe, expect, it } from "vitest";
import { parseCommand } from "@/lib/operator/grammar";

describe("parseCommand: HyperCore deposits", () => {
  it.each([
    ["move $5 to hyperliquid", { kind: "hypercore", amountUsd: "5" }],
    ["Move 5 to Hyperliquid", { kind: "hypercore", amountUsd: "5" }],
    ["send $5 to hyperliquid", { kind: "hypercore", amountUsd: "5" }],
    ["deposit $2.50 into my hyperliquid spot", { kind: "hypercore", amountUsd: "2.50" }],
    ["move 10 usdc to hypercore", { kind: "hypercore", amountUsd: "10" }],
    ["move $5 to hl", { kind: "hypercore", amountUsd: "5" }],
    ["send @alex $5 to hyperliquid", { kind: "hypercore", amountUsd: "5", counterparty: "@alex" }],
    ["send alex $5 to their hyperliquid", { kind: "hypercore", amountUsd: "5", counterparty: "alex" }],
    ["send $5 to @alex to hyperliquid", { kind: "hypercore", amountUsd: "5", counterparty: "@alex" }],
    ["send $5 to alex on hypercore", { kind: "hypercore", amountUsd: "5", counterparty: "alex" }],
    ["pay +1 555 000 0010 $3 to hyperliquid", { kind: "hypercore", amountUsd: "3", counterparty: "+1 555 000 0010" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it("keeps \"on hyperliquid\" a HyperEVM send", () => {
    expect(parseCommand("send @alex $5 on hyperliquid")).toEqual({ kind: "send", counterparty: "@alex", amountUsd: "5", chain: "hyperevm" });
  });

  it("refuses amounts with more than two decimals", () => {
    expect(parseCommand("move $5.555 to hyperliquid")).toEqual({ kind: "chat" });
  });
});

describe("parseCommand: Hyperliquid reads", () => {
  it.each(["hl balance", "HL bal", "hyperliquid balance?", "balance on hyperliquid", "bal hypercore"])("%s", (text) => {
    expect(parseCommand(text)).toEqual({ kind: "hl_balance" });
  });

  it.each([
    ["price BTC", "BTC"],
    ["price hype", "HYPE"],
    ["price of $eth?", "ETH"],
    ["px sol", "SOL"],
    ["btc price", "BTC"],
  ])("%s", (text, coin) => {
    expect(parseCommand(text)).toEqual({ kind: "price", coin });
  });

  it("leaves plain balance alone", () => {
    expect(parseCommand("balance")).toEqual({ kind: "balance" });
  });
});

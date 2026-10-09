import { describe, expect, it } from "vitest";
import { parseCommand } from "@/lib/operator/grammar";
import { REGISTRY } from "@/lib/settlement/registry";
import {
  findStock,
  formatAmount,
  formatShares,
  formatTotals,
  isShareAmount,
  sharesToUnits,
  STOCK_TOKEN_ADDRESSES,
  stockForToken,
  stocksOn,
  usdAmount,
} from "@/lib/stocks";

const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const USD = "0x2195e3E09eab088c90B4461B92D06A74d30c1e2e";

describe("share amounts", () => {
  it.each([
    ["0.1", 100_000n],
    ["5", 5_000_000n],
    ["0.000001", 1n],
    ["2.5", 2_500_000n],
    ["999999.999999", 999_999_999_999n],
  ])("%s is %s millionths", (s, units) => {
    expect(isShareAmount(s)).toBe(true);
    expect(sharesToUnits(s)).toBe(units);
  });

  it.each(["", "abc", "-1", "1.0000001", "1234567", "$5", "1e3"])("rejects %j", (s) => {
    expect(isShareAmount(s)).toBe(false);
  });

  it("prints without trailing zeros", () => {
    expect(formatShares(100_000n)).toBe("0.1");
    expect(formatShares(5_000_000n)).toBe("5");
    expect(formatShares(1n)).toBe("0.000001");
    expect(formatShares(0n)).toBe("0");
  });
});

describe("stock tokens in the registry", () => {
  it("lists Robinhood's testnet stock tokens on the robinhood entry, beside Dial Test USD", () => {
    const entry = REGISTRY.robinhood.testnet;
    expect(entry?.kind).toBe("evm");
    expect(entry?.kind === "evm" && entry.token).toBe(USD);
    expect(stocksOn("robinhood", "testnet").map((s) => s.symbol)).toEqual(["TSLA", "AMZN", "PLTR", "NFLX", "AMD"]);
    expect(findStock("robinhood", "testnet", "tsla")?.address).toBe(TSLA);
  });

  it("has none anywhere else, and none on mainnet", () => {
    expect(stocksOn("robinhood", "mainnet")).toEqual([]);
    expect(stocksOn("base", "testnet")).toEqual([]);
    expect(stocksOn("solana", "testnet")).toEqual([]);
    expect(STOCK_TOKEN_ADDRESSES).toHaveLength(5);
  });

  it("knows a payment's stock by token, in any address case", () => {
    expect(stockForToken("robinhood", TSLA.toLowerCase())?.symbol).toBe("TSLA");
    expect(stockForToken("robinhood", USD)).toBeNull();
    expect(stockForToken("base", TSLA)).toBeNull();
  });
});

describe("amounts as people read them", () => {
  const stock = { chain: "robinhood" as const, token: TSLA, amount: 100_000n };
  const dollars = { chain: "robinhood" as const, token: USD, amount: 5_000_000n };

  it("shows shares and the ticker for a stock, dollars otherwise", () => {
    expect(formatAmount(stock, "testnet")).toBe("0.1 TSLA");
    expect(formatAmount(dollars, "testnet")).toBe("$5");
  });

  it("has no dollar amount for a stock: testnet has no price", () => {
    expect(usdAmount(stock)).toBeNull();
    expect(usdAmount(dollars)).toBe(5_000_000n);
  });

  it("totals per asset", () => {
    expect(formatTotals([dollars, dollars], "testnet")).toBe("$10");
    expect(formatTotals([dollars, stock, stock], "testnet")).toBe("$5 USDC and 0.2 TSLA");
    expect(formatTotals([stock], "testnet")).toBe("0.1 TSLA");
  });
});

describe("parseCommand: stocks", () => {
  it.each([
    ["send @alex 0.1 TSLA", { kind: "send", counterparty: "@alex", amountUsd: "0.1", asset: "TSLA" }],
    ["send alex 1 tsla", { kind: "send", counterparty: "alex", amountUsd: "1", asset: "TSLA" }],
    ["give @alex 2 shares of AMZN", { kind: "send", counterparty: "@alex", amountUsd: "2", asset: "AMZN" }],
    ["send 0.5 $NFLX to @sam", { kind: "send", counterparty: "@sam", amountUsd: "0.5", asset: "NFLX" }],
    ["send 1 share of PLTR to my brother jake", { kind: "send", counterparty: "my brother jake", amountUsd: "1", asset: "PLTR" }],
    [
      "send @alex 0.1 TSLA for your birthday",
      { kind: "send", counterparty: "@alex", amountUsd: "0.1", asset: "TSLA", note: "your birthday" },
    ],
    ["send @alex 0.1 TSLA on robinhood", { kind: "send", counterparty: "@alex", amountUsd: "0.1", asset: "TSLA", chain: "robinhood" }],
    ["send +1 555 000 0010 3 AMD", { kind: "send", counterparty: "+1 555 000 0010", amountUsd: "3", asset: "AMD" }],
    // Not on the testnet, but typed like a ticker: the operator says which ones are.
    ["send @alex 1 AAPL", { kind: "send", counterparty: "@alex", amountUsd: "1", asset: "AAPL" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it.each([
    ["send @alex $5 of TSLA", "TSLA"],
    ["send alex $5 worth of tsla", "TSLA"],
    ["send $10 in AMZN to @sam", "AMZN"],
  ])("%s is the priced form", (text, symbol) => {
    expect(parseCommand(text)).toEqual({ kind: "stock_priced", symbol });
  });

  it.each(["stocks", "Portfolio", "my stocks", "holdings?"])("%s shows the portfolio", (text) => {
    expect(parseCommand(text)).toEqual({ kind: "stocks" });
  });

  it("leaves dollar sends and lowercase words alone", () => {
    expect(parseCommand("send alex 5 bucks")).toEqual({ kind: "send", counterparty: "alex", amountUsd: "5" });
    expect(parseCommand("send alex $5")).toEqual({ kind: "send", counterparty: "alex", amountUsd: "5" });
    expect(parseCommand("send jake 20 tmrw")).toEqual({ kind: "chat" });
    expect(parseCommand("send @alex 0.1 TSLA on dogecoin")).toEqual({ kind: "chat" });
  });
});

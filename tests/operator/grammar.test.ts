import { describe, expect, it } from "vitest";
import { parseCommand } from "@/lib/operator/grammar";

describe("parseCommand: send", () => {
  it.each([
    ["send jeremy $10", { kind: "send", counterparty: "jeremy", amountUsd: "10" }],
    ["Send Jeremy 10", { kind: "send", counterparty: "jeremy", amountUsd: "10" }],
    ["pay @jeremy $10.50", { kind: "send", counterparty: "@jeremy", amountUsd: "10.50" }],
    ["send $5 to alex", { kind: "send", counterparty: "alex", amountUsd: "5" }],
    ["send 5 bucks to alex", { kind: "send", counterparty: "alex", amountUsd: "5" }],
    ["send jeremy $10 on sol", { kind: "send", counterparty: "jeremy", amountUsd: "10", chain: "solana" }],
    ["send $10 to jeremy on tempo", { kind: "send", counterparty: "jeremy", amountUsd: "10", chain: "tempo" }],
    ["send +1 806 607 1387 $5", { kind: "send", counterparty: "+1 806 607 1387", amountUsd: "5" }],
    ["send $5 to (806) 607-1387", { kind: "send", counterparty: "(806) 607-1387", amountUsd: "5" }],
    ["give jeremy 20 usdc", { kind: "send", counterparty: "jeremy", amountUsd: "20" }],
    ["  send   jeremy   $10!  ", { kind: "send", counterparty: "jeremy", amountUsd: "10" }],
    ["send jeremy $10 for pizza", { kind: "send", counterparty: "jeremy", amountUsd: "10", note: "pizza" }],
    [
      "send $12 to sam for movie tickets on base",
      { kind: "send", counterparty: "sam", amountUsd: "12", note: "movie tickets", chain: "base" },
    ],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });
});

describe("parseCommand: request and invoice", () => {
  it.each([
    ["request $25 from adam", { kind: "request", counterparty: "adam", amountUsd: "25" }],
    ["request $25 from adam for pizza", { kind: "request", counterparty: "adam", amountUsd: "25", note: "pizza" }],
    ["request adam $25", { kind: "request", counterparty: "adam", amountUsd: "25" }],
    ["ask +1 555 000 0001 for $8", { kind: "request", counterparty: "+1 555 000 0001", amountUsd: "8" }],
    [
      "invoice sam $200 for logo design",
      { kind: "invoice", counterparty: "sam", amountUsd: "200", note: "logo design" },
    ],
    [
      "bill sam $200 for logo design on tempo",
      { kind: "invoice", counterparty: "sam", amountUsd: "200", note: "logo design", chain: "tempo" },
    ],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });
});

describe("parseCommand: withdraw", () => {
  const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const EVM = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb";
  it.each([
    [`withdraw $10 to ${SOL}`, { kind: "withdraw", amountUsd: "10", address: SOL }],
    [`send $10 to ${SOL}`, { kind: "withdraw", amountUsd: "10", address: SOL }],
    [`withdraw all to ${SOL}`, { kind: "withdraw", amountUsd: "all", address: SOL }],
    [`cash out 5 to ${EVM} on base`, { kind: "withdraw", amountUsd: "5", address: EVM, chain: "base" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });
});

describe("parseCommand: other", () => {
  it.each(["balance", "Balance?", "bal"])("%s → balance", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "balance" });
  });

  it.each(["receive", "my address", "address", "deposit"])("%s → receive", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "receive" });
  });

  it.each([
    ["reclaim", "reclaim"],
    ["Refund", "reclaim"],
    ["upgrade", "upgrade"],
    ["no", "decline"],
    ["Decline", "decline"],
  ])("%s → %s", (t, kind) => {
    expect(parseCommand(t)).toEqual({ kind });
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

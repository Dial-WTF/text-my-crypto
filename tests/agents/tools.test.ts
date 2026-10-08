import { describe, expect, it } from "vitest";
import { MONEY_TOOLS, toolInputs } from "@/lib/agents/tools";

describe("tool input validation", () => {
  it("accepts well-formed payments", () => {
    expect(toolInputs.send_payment.safeParse({ to: "@jeremy", amountUsd: "10" }).success).toBe(true);
    expect(toolInputs.send_payment.safeParse({ to: "+15550000011", amountUsd: " 2.50 ", note: "lunch", chain: "solana" }).data).toEqual({
      to: "+15550000011",
      amountUsd: "2.50",
      note: "lunch",
      chain: "solana",
    });
    expect(toolInputs.request_payment.safeParse({ from: "adam", amountUsd: "25" }).success).toBe(true);
    expect(toolInputs.withdraw.safeParse({ amountUsd: "all", address: "So11111111111111111111111111111111111111112" }).success).toBe(true);
  });

  it.each([
    ["number amount", { to: "@jeremy", amountUsd: 10 }],
    ["word amount", { to: "@jeremy", amountUsd: "ten" }],
    ["three decimals", { to: "@jeremy", amountUsd: "1.005" }],
    ["negative", { to: "@jeremy", amountUsd: "-5" }],
    ["dollar sign", { to: "@jeremy", amountUsd: "$5" }],
    ["missing recipient", { amountUsd: "5" }],
    ["empty recipient", { to: " ", amountUsd: "5" }],
    ["unknown chain", { to: "@jeremy", amountUsd: "5", chain: "dogecoin" }],
    ["long note", { to: "@jeremy", amountUsd: "5", note: "x".repeat(121) }],
  ])("rejects %s", (_, input) => {
    expect(toolInputs.send_payment.safeParse(input).success).toBe(false);
  });

  it("only accepts payment-shaped ids", () => {
    expect(toolInputs.get_payment.safeParse({ intentId: "pi_U2JhVg59pPa_w8sd" }).success).toBe(true);
    expect(toolInputs.get_payment.safeParse({ intentId: "usr_abc" }).success).toBe(false);
    expect(toolInputs.get_payment.safeParse({ intentId: "pi_' OR 1=1 --" }).success).toBe(false);
  });

  it("bounds list size", () => {
    expect(toolInputs.list_payments.safeParse({}).success).toBe(true);
    expect(toolInputs.list_payments.safeParse({ limit: 51 }).success).toBe(false);
    expect(toolInputs.list_payments.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("marks exactly the money tools", () => {
    expect([...MONEY_TOOLS].sort()).toEqual(["create_invoice", "request_payment", "send_payment", "withdraw"]);
  });

  it("publishes a JSON Schema for every tool", () => {
    for (const schema of Object.values(toolInputs)) {
      const js = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      expect(js).toMatchObject({ type: "object" });
    }
  });
});

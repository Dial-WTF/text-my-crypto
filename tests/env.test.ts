import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvForTests } from "@/lib/env";

const base = {
  APP_URL: "https://tmc.example",
  PAYPHONE_API_KEY: "dial_test_x",
  DIAL_OPERATOR_NUMBER: "+18066071387",
  SMS_WEBHOOK_SECRET: "a".repeat(43),
  WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SOLANA_TREASURY_SEED: Buffer.alloc(32, 2).toString("base64"),
  AI_GATEWAY_API_KEY: "gw_test",
};

afterEach(() => resetEnvForTests());

describe("env", () => {
  it("parses a valid environment and applies defaults", () => {
    Object.assign(process.env, base);
    const e = env();
    expect(e.SOLANA_RPC_URL).toBe("https://api.devnet.solana.com");
    expect(e.SOLANA_USDC_MINT).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(e.PER_TX_CAP_USD).toBe("50");
    expect(e.SMS_MODE).toBe("log");
  });

  it("rejects a bad bot number", () => {
    Object.assign(process.env, base, { DIAL_OPERATOR_NUMBER: "8066071387" });
    expect(() => env()).toThrow();
  });
});

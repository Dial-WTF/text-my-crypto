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
    expect(e.NETWORK).toBe("testnet");
    expect(e.CHAINS).toBe("solana,tempo");
    expect(e.PER_TX_CAP_USD).toBe("50");
    expect(e.SMS_MODE).toBe("log");
  });

  it("refuses mainnet without the explicit go-ahead", () => {
    Object.assign(process.env, base, { NETWORK: "mainnet" });
    expect(() => env()).toThrow(/ALLOW_MAINNET/);
    resetEnvForTests();
    Object.assign(process.env, { ALLOW_MAINNET: "yes" });
    expect(env().NETWORK).toBe("mainnet");
    delete process.env.NETWORK;
    delete process.env.ALLOW_MAINNET;
  });

  it("treats an empty Alchemy key as unset", () => {
    Object.assign(process.env, base, { ALCHEMY_API_KEY: "" });
    expect(env().ALCHEMY_API_KEY).toBeUndefined();
    delete process.env.ALCHEMY_API_KEY;
  });

  it("needs a Payphone key only when it sends real texts", () => {
    Object.assign(process.env, base, { PAYPHONE_API_KEY: "" });
    expect(env().PAYPHONE_API_KEY).toBeUndefined();
    resetEnvForTests();
    Object.assign(process.env, { SMS_MODE: "payphone" });
    expect(() => env()).toThrow(/PAYPHONE_API_KEY/);
    Reflect.deleteProperty(process.env, "SMS_MODE");
    process.env.PAYPHONE_API_KEY = base.PAYPHONE_API_KEY;
  });

  it("rejects a bad bot number", () => {
    Object.assign(process.env, base, { DIAL_OPERATOR_NUMBER: "8066071387" });
    expect(() => env()).toThrow();
  });
});

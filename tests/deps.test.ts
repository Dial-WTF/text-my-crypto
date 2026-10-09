import { afterEach, describe, expect, it, vi } from "vitest";
import { botDeps } from "@/lib/deps";
import { resetEnvForTests } from "@/lib/env";

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/settlement", () => ({ getAdapters: () => ({}) }));

const base = {
  APP_URL: "https://tmc.example",
  PAYPHONE_API_KEY: "dial_test_x",
  DIAL_OPERATOR_NUMBER: "+18066071387",
  SMS_WEBHOOK_SECRET: "a".repeat(43),
  WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SOLANA_TREASURY_SEED: Buffer.alloc(32, 2).toString("base64"),
  SIGNUP_DRIP_USD: "25",
};

afterEach(() => {
  delete process.env.NETWORK;
  delete process.env.ALLOW_MAINNET;
  resetEnvForTests();
});

describe("botDeps signup drip", () => {
  it("drips test money on testnet", () => {
    Object.assign(process.env, base, { NETWORK: "testnet" });
    expect(botDeps().dripAmount).toBe(25_000_000n);
  });

  it("never drips on mainnet, whatever SIGNUP_DRIP_USD says", () => {
    Object.assign(process.env, base, { NETWORK: "mainnet", ALLOW_MAINNET: "yes" });
    const deps = botDeps();
    expect(deps.network).toBe("mainnet");
    expect(deps.dripAmount).toBe(0n);
  });
});

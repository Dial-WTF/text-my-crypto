import { describe, expect, it } from "vitest";
import { createUser } from "@/lib/identity";
import { cleanAsk, payProfile } from "@/lib/views/pay";
import { walletJson, walletView } from "@/lib/views/wallet";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const now = new Date("2026-10-09T12:00:00Z");

async function setup() {
  const db = await createTestDb();
  const deps = testDeps(db, { sendSms: smsSink().sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 7_500_000n }) } });
  const user = await createUser(db, { phone: "+15550000401", handle: "alex", name: "Alex Rivera" }, now);
  return { db, deps, user };
}

describe("pay profile", () => {
  it("gives payers a text, a wallet link per chain and nothing private", async () => {
    const { deps, user } = await setup();
    const p = await payProfile(deps, user, { amountUsd: "5", note: "pizza" });
    expect(p.url).toBe("https://tmc.test/@alex?amount=5&note=pizza");
    expect(p.byText.body).toBe("send @alex $5 for pizza");
    expect(p.chains).toHaveLength(1);
    expect(p.chains[0]).toMatchObject({ chain: "solana", network: "Solana devnet", address: "solanaAddr1" });
    expect(p.chains[0]?.uri).toMatch(/^solana:solanaAddr1\?amount=5&spl-token=/);
    expect(JSON.stringify(p)).not.toMatch(/555|balance/i);
  });

  it("opens the wallet once and reuses it", async () => {
    const { deps, user } = await setup();
    const a = await payProfile(deps, user);
    const b = await payProfile(deps, user);
    expect(b.chains[0]?.address).toBe(a.chains[0]?.address);
  });

  it("ignores amounts it can't honor and trims notes", () => {
    const deps = { perTxCap: 50_000_000n };
    expect(cleanAsk(deps, { amount: "$12.50", note: "  dinner   out " })).toEqual({ amountUsd: "12.50", note: "dinner out" });
    expect(cleanAsk(deps, { amount: "500" })).toEqual({});
    expect(cleanAsk(deps, { amount: "0" })).toEqual({});
    expect(cleanAsk(deps, { amount: "abc", note: "" })).toEqual({});
  });
});

describe("wallet view", () => {
  it("shows balances, pay link and agents, as JSON with dollar strings", async () => {
    const { deps, user } = await setup();
    const json = walletJson(await walletView(deps, user));
    expect(json.payUrl).toBe("https://tmc.test/@alex");
    expect(json.chains[0]).toMatchObject({ chain: "solana", balanceUsd: "7.5" });
    expect(json.agents).toEqual([]);
    expect(json.passkey).toBe(false);
  });
});

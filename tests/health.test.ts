import { describe, expect, it } from "vitest";
import { dependencyChecks } from "@/lib/health";
import { createTestDb } from "./helpers/db";
import { fakeAdapter } from "./helpers/fakes";

describe("dependencyChecks", () => {
  it("probes Zcash through its own treasury, the only kind of address its service can read", async () => {
    const zec = fakeAdapter({ chain: "zcash" });
    const asked: string[] = [];
    const getBalance = zec.getBalance;
    zec.getBalance = async (a) => (asked.push(a), getBalance(a));
    const checks = await dependencyChecks({
      db: await createTestDb(),
      payphone: { baseUrl: "https://payphone.test", apiKey: "k" },
      adapters: { zcash: zec },
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(asked).toEqual(["zcashTreasury"]);
    expect(checks.zcashBalance?.ok).toBe(true);
  });
});

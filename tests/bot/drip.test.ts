import { beforeEach, describe, expect, it, vi } from "vitest";
import { dripOnce, ensureWallet } from "@/lib/bot/accounts";
import { createMoneyIntent } from "@/lib/bot/money";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import type { User } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { ChainDownError } from "@/lib/settlement/types";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, testDeps } from "../helpers/fakes";

let db: Db;
let alex: User;
let jeremy: User;

/** A chain whose treasury can't pay out: every fund() throws. Balances start at zero. */
function brokeAdapter(chain: "solana" | "tempo", error: () => Error): FakeAdapter & { fundCalls: number } {
  const base = fakeAdapter({ chain, defaultBalance: 0n });
  const a = Object.assign(base, { fundCalls: 0 });
  a.fund = async () => {
    a.fundCalls++;
    throw error();
  };
  return a;
}

const send = (deps: BotDeps, chain: "solana" | "tempo") =>
  createMoneyIntent(deps, alex, { kind: "send", counterparty: "@jeremy", amountUsd: "5", chain }, jeremy);

beforeEach(async () => {
  db = await createTestDb();
  alex = await createUser(db, { phone: "+15550000010", handle: "alex", name: "Alex" });
  jeremy = await createUser(db, { phone: "+15550000011", handle: "jeremy", name: "Jeremy" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a short send whose drip fails", () => {
  it("says there isn't enough instead of ending the turn", async () => {
    const sol = brokeAdapter("solana", () => new ChainDownError("solana", new Error("429 Too Many Requests")));
    const deps = testDeps(db, { adapters: { solana: sol } });
    await ensureWallet(deps, alex.id, "solana", sol);

    const r = await send(deps, "solana");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("insufficient");
    expect(sol.fundCalls).toBe(1);
    // Given back, so a later turn can try again.
    expect((await getWallet(db, alex.id, "solana"))?.drippedAt).toBeNull();
  });

  it("tries the drip once, not twice, for a wallet opened this turn", async () => {
    const tempo = brokeAdapter("tempo", () => new Error("treasury empty"));
    const deps = testDeps(db, { adapters: { solana: fakeAdapter(), tempo } });

    const r = await send(deps, "tempo");
    expect(!r.ok && r.error.code).toBe("insufficient");
    expect(tempo.fundCalls).toBe(1);
    expect(await getWallet(db, alex.id, "tempo")).not.toBeNull();
  });

  it("still drips an existing wallet that never got one", async () => {
    const sol = fakeAdapter({ chain: "solana", defaultBalance: 0n });
    const deps = testDeps(db, { adapters: { solana: sol } });
    await ensureWallet(deps, alex.id, "solana", sol);

    const r = await send(deps, "solana");
    expect(r.ok).toBe(true);
    expect(sol.funded).toHaveLength(1);
  });
});

describe("dripOnce after a transfer that went out unconfirmed", () => {
  it("keeps the drip taken, so it is never sent twice", async () => {
    const sol = brokeAdapter("solana", () => new TransferUnconfirmedError("solana", "0xabc", new Error("receipt timeout")));
    const deps = testDeps(db, { adapters: { solana: sol } });
    const w = await ensureWallet(deps, alex.id, "solana", sol);

    await expect(dripOnce(deps, w, sol)).rejects.toBeInstanceOf(TransferUnconfirmedError);
    expect((await getWallet(db, alex.id, "solana"))?.drippedAt).not.toBeNull();
    expect(await dripOnce(deps, w, sol)).toBe(false);
    expect(sol.fundCalls).toBe(1);
  });

  it("gives the drip back when nothing was sent", async () => {
    const sol = brokeAdapter("solana", () => new Error("rpc refused"));
    const deps = testDeps(db, { adapters: { solana: sol } });
    const w = await ensureWallet(deps, alex.id, "solana", sol);

    await expect(dripOnce(deps, w, sol)).rejects.toThrow("rpc refused");
    expect((await getWallet(db, alex.id, "solana"))?.drippedAt).toBeNull();
  });
});

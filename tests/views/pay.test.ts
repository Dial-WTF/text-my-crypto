import { describe, expect, it } from "vitest";
import { wallets } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { createIntent } from "@/lib/intents";
import { stateLabel } from "@/lib/payment-labels";
import { cleanAsk, payProfile } from "@/lib/views/pay";
import { walletJson, walletView } from "@/lib/views/wallet";
import { handleFromParam } from "@/lib/web/pay-page";
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
    // The same payment as a Solana Action, and a dial.to Blink for it on devnet.
    const action = "https://tmc.test/api/actions/pay/alex?amount=5&note=pizza";
    expect(p.chains[0]?.action).toEqual({
      url: action,
      uri: `solana-action:${action}`,
      blink: `https://dial.to/?action=${encodeURIComponent(`solana-action:${action}`)}&cluster=devnet`,
    });
    expect(JSON.stringify(p)).not.toMatch(/555|balance/i);
  });

  it("opens the wallet once and reuses it", async () => {
    const { deps, user } = await setup();
    const a = await payProfile(deps, user);
    const b = await payProfile(deps, user);
    expect(b.chains[0]?.address).toBe(a.chains[0]?.address);
  });

  it("opens one wallet when first visits arrive at the same time", async () => {
    const { db, deps, user } = await setup();
    const profiles = await Promise.all([payProfile(deps, user), payProfile(deps, user), payProfile(deps, user)]);
    const addresses = new Set(profiles.map((p) => p.chains[0]?.address));
    expect(addresses.size).toBe(1);
    expect(await db.select().from(wallets)).toHaveLength(1);
  });

  it("ignores amounts it can't honor and trims notes", () => {
    const deps = { perTxCap: 50_000_000n };
    expect(cleanAsk(deps, { amount: "$12.50", note: "  dinner   out " })).toEqual({ amountUsd: "12.50", note: "dinner out" });
    expect(cleanAsk(deps, { amount: "500" })).toEqual({});
    expect(cleanAsk(deps, { amount: "0" })).toEqual({});
    expect(cleanAsk(deps, { amount: "abc", note: "" })).toEqual({});
  });

  it("strips bidi overrides, zero-width and control characters from notes", () => {
    const deps = { perTxCap: 50_000_000n };
    expect(cleanAsk(deps, { note: "rent‮txt.exe‬" })).toEqual({ note: "renttxt.exe" });
    expect(cleanAsk(deps, { note: "pi​zza ⁦for⁩ \u0007you‍" })).toEqual({ note: "pizza for you" });
    expect(cleanAsk(deps, { note: "a\tb\nc" })).toEqual({ note: "a b c" });
    expect(cleanAsk(deps, { note: "​‎﻿" })).toEqual({});
  });
});

describe("pay page handles", () => {
  it("reads a handle from the route param and refuses anything that can't be one", () => {
    expect(handleFromParam("Alex")).toBe("alex");
    expect(handleFromParam("@alex")).toBe("alex");
    expect(handleFromParam("%40alex")).toBe("alex");
    // Next has decoded /@%25E0 to "%E0" already; decoding again would throw a URIError.
    expect(handleFromParam("%E0")).toBeNull();
    expect(handleFromParam("%")).toBeNull();
    expect(handleFromParam("al ex")).toBeNull();
    expect(handleFromParam("")).toBeNull();
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

  it("flags a payment waiting on the owner until its deadline, then labels it expired", async () => {
    const { db, deps, user } = await setup();
    const bob = await createUser(db, { phone: "+15550000402", handle: "bob" }, now);
    await createIntent(
      db,
      {
        kind: "send",
        createdBy: user.id,
        senderId: user.id,
        recipientId: bob.id,
        chain: "solana",
        token: "Mint111",
        recipientAddress: "bobAddr",
        amount: 1_690_000n,
        note: null,
        escrowSecretEnc: null,
      },
      new Date(deps.now().getTime() - 60_000),
    );
    const [open] = (await walletView(deps, user)).activity;
    expect(open).toMatchObject({ other: "@bob", direction: "out", waitingOnYou: true });
    expect(stateLabel(open!.status, open!.expiresAt, deps.now())).toBe("awaiting approval");

    const later = new Date(deps.now().getTime() + 15 * 60_000);
    const [stale] = (await walletView({ ...deps, now: () => later }, user)).activity;
    expect(stale?.waitingOnYou).toBe(false);
    expect(stateLabel(stale!.status, stale!.expiresAt, later)).toBe("expired");
  });
});


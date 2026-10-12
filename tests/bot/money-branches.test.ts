import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWallet } from "@/lib/bot/accounts";
import {
  checkMoney,
  createMoneyIntent,
  createWithdrawIntent,
  insufficientReply,
  prepareMoney,
  resolveCounterparty,
} from "@/lib/bot/money";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { getConversation } from "@/lib/conversations";
import { intents, type User, users } from "@/lib/db/schema";
import { createUnclaimedUser, createUser } from "@/lib/identity";
import type { NameService } from "@/lib/settlement/capabilities";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, fakeEscrow, smsSink, testDeps } from "../helpers/fakes";

const JEREMY = "+15550000011";
const ALEX = "+15550000010";
const NEWBIE = "+15550000099";
const SOL_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let jeremy: User;
let alex: User;

/** A name service that knows nobody, recording what it was asked. */
function emptyNames(suffixes: string[]): NameService & { asked: string[] } {
  const asked: string[] = [];
  return {
    suffixes,
    asked,
    resolve: async (name) => {
      asked.push(name);
      return null;
    },
  };
}

/** An adapter whose payments carry `fee` on top, recording which kind of recipient each fee was for. */
function feeAdapter(fee: bigint, balance: bigint, escrow = false): FakeAdapter & { feeKinds: string[] } {
  const a = Object.assign(fakeAdapter({ defaultBalance: balance, ...(escrow ? { escrow: fakeEscrow() } : {}) }), {
    feeKinds: [] as string[],
  });
  a.carriedFees = (to) => {
    a.feeKinds.push(to);
    return fee;
  };
  return a;
}

const intentCount = async () => (await db.select().from(intents)).length;

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol } });
  jeremy = await createUser(db, { phone: JEREMY, handle: "jeremy", name: "Jeremy" });
  alex = await createUser(db, { phone: ALEX, handle: "alex", name: "Alex" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveCounterparty", () => {
  it("connects a bare handle without the @ straight to its owner", async () => {
    expect(await resolveCounterparty(deps, jeremy, "alex")).toEqual({ user: alex });
  });

  it("never resolves the sender's own bare handle to themself: it asks for a number instead", async () => {
    // "jeremy" is an exact handle, but it's the owner; the directory skips them too.
    expect(await resolveCounterparty(deps, jeremy, "jeremy")).toEqual({ askFor: "jeremy" });
  });
});

describe("checkMoney", () => {
  it("refuses an amount that isn't a dollar figure, quoting the per-payment cap", () => {
    const r = checkMoney(deps, jeremy, { amountUsd: "ten bucks" });
    expect(r).toEqual({ ok: false, error: { code: "bad_amount", message: "Amounts can be from $0.01 to $50." } });
  });
});

describe("insufficientReply", () => {
  it("points someone without a handle at their wallet page, with the faucet on testnet", () => {
    const anon = { ...jeremy, handle: null };
    const reply = insufficientReply(deps, anon, "solana", 2_000_000n);
    expect(reply).toContain("Add more: https://tmc.test/wallet");
    expect(reply).toContain("Free test USDC: faucet.circle.com");
    expect(reply).not.toContain("/@");
  });
});

describe("createMoneyIntent", () => {
  it("runs the same up-front checks as the SMS path: a chain that's off creates nothing", async () => {
    const r = await createMoneyIntent(deps, jeremy, { kind: "send", counterparty: "@alex", amountUsd: "5", chain: "tempo" }, alex);
    expect(r).toEqual({ ok: false, error: { code: "chain_unavailable", message: "Tempo isn't switched on yet. Try Solana." } });
    expect(await intentCount()).toBe(0);
  });

  it("refuses paying yourself", async () => {
    const r = await createMoneyIntent(deps, jeremy, { kind: "request", counterparty: "@jeremy", amountUsd: "5" }, jeremy);
    expect(r).toEqual({ ok: false, error: { code: "self", message: "That's you. Pick someone else." } });
    expect(await intentCount()).toBe(0);
  });

  it("charges carried fees by recipient kind and refuses a send the fees push over the balance", async () => {
    // $10 on hand, $10 to send, $0.05 in fees on top: enough for the payment, not for the fees.
    const noDrip = { dripAmount: 0n };
    const feeShort =
      "You have $10, but on Solana that payment also needs $0.05 for network fees, so I didn't send it. Nothing moved. Try a little less.";

    // To someone on Dial: the "dial" fee.
    const toMember = feeAdapter(50_000n, 10_000_000n);
    const memberDeps = { ...deps, ...noDrip, adapters: { solana: toMember } };
    const r1 = await createMoneyIntent(memberDeps, jeremy, { kind: "send", counterparty: "@alex", amountUsd: "10" }, alex);
    expect(r1).toEqual({ ok: false, error: { code: "insufficient", message: feeShort } });
    expect(toMember.feeKinds).toEqual(["dial"]);

    // To a newcomer on a chain with an escrow program: the money leaves for the vault, an "outside" fee.
    const newbie = await createUnclaimedUser(db, NEWBIE);
    const withEscrow = feeAdapter(50_000n, 10_000_000n, true);
    const escrowDeps = { ...deps, ...noDrip, adapters: { solana: withEscrow } };
    const r2 = await createMoneyIntent(escrowDeps, jeremy, { kind: "send", counterparty: NEWBIE, amountUsd: "10" }, newbie);
    expect(r2).toEqual({ ok: false, error: { code: "insufficient", message: feeShort } });
    expect(withEscrow.feeKinds).toEqual(["outside"]);
    expect(await intentCount()).toBe(0);
  });
});

describe("createWithdrawIntent", () => {
  const withdraw = (amountUsd: string, address = SOL_ADDRESS) => createWithdrawIntent(deps, jeremy, { kind: "withdraw", amountUsd, address });

  it("refuses more than the balance, pointing at the pay page and the faucet", async () => {
    const mine = await ensureWallet(deps, jeremy.id, "solana", sol);
    sol.balances.set(mine.address, 10_000_000n);
    const r = await withdraw("20");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("insufficient");
    expect(r.error.message).toContain("Add more: https://tmc.test/@jeremy");
    expect(r.error.message).toContain("Free test USDC: faucet.circle.com");
    expect(await intentCount()).toBe(0);
  });

  it("applies the daily cap to withdrawals like sends", async () => {
    deps = { ...deps, perDayCap: 5_000_000n };
    expect(await withdraw("10")).toEqual({
      ok: false,
      error: { code: "over_daily", message: 'Text-only accounts can send $5 a day. Text "upgrade" to add a passkey for higher limits.' },
    });
    expect(await intentCount()).toBe(0);
  });

  it("treats an amount that isn't a dollar figure as nothing to withdraw, and creates nothing", async () => {
    // The grammar and MCP never pass one, but a stored conversation's command is only checked to be a string.
    const r = await withdraw("lots");
    expect(r.ok ? null : r.error.code).toBe("nothing_to_withdraw");
    expect(await intentCount()).toBe(0);
  });

  it("an empty wallet elsewhere isn't offered as somewhere the money is", async () => {
    const tempo = fakeAdapter({ chain: "tempo", defaultBalance: 0n });
    const empty = fakeAdapter({ defaultBalance: 0n });
    deps = { ...deps, adapters: { solana: empty, tempo } };
    await ensureWallet(deps, jeremy.id, "tempo", tempo);
    expect(await withdraw("all")).toEqual({
      ok: false,
      error: { code: "nothing_to_withdraw", message: "Your balance is $0. Nothing to withdraw." },
    });

    // Contrast: with money on Tempo, the reply says where it is.
    const tempoWallet = await ensureWallet(deps, jeremy.id, "tempo", tempo);
    tempo.balances.set(tempoWallet.address, 5_000_000n);
    const r = await withdraw("all");
    expect(r.ok ? null : r.error.message).toBe(
      'Your Solana balance is $0. You have $5 on Tempo. To move it, text "withdraw all to <address> on tempo".',
    );
  });

  it("with no name services at all, a name doesn't point anywhere and no network is named", async () => {
    expect(deps.names).toBeUndefined();
    expect(await withdraw("5", "vitalik.eth")).toEqual({
      ok: false,
      error: { code: "unknown_name", message: "vitalik.eth doesn't point to an address. Check the name and try again." },
    });
  });

  it("looks up a name ENS can't normalize by its lowercased spelling", async () => {
    // An underscore is only allowed at the start of an ENS label, so normalizing "Ab_c.eth" fails.
    const ens = emptyNames([".eth"]);
    deps = { ...deps, names: { ethereum: ens } };
    expect(await withdraw("5", "Ab_c.eth")).toEqual({
      ok: false,
      error: { code: "unknown_name", message: "ab_c.eth doesn't point to an address on Ethereum Sepolia. Check the name and try again." },
    });
    expect(ens.asked).toEqual(["ab_c.eth"]);
  });

  it("names the chain itself when the registry has no entry for it on this network", async () => {
    // Zcash has no mainnet entry, so there's no network name to quote: fall back to the chain's label.
    const names = emptyNames([".eth"]);
    deps = { ...deps, network: "mainnet", names: { zcash: names } };
    expect(await withdraw("5", "nobody.eth")).toEqual({
      ok: false,
      error: { code: "unknown_name", message: "nobody.eth doesn't point to an address on Zcash. Check the name and try again." },
    });
  });
});

describe("prepareMoney", () => {
  it("refuses sending to your own number", async () => {
    expect(await prepareMoney(deps, jeremy, { kind: "send", counterparty: JEREMY, amountUsd: "5" })).toBe("That's you. Pick someone else.");
    expect(await intentCount()).toBe(0);
    expect(sol.settled).toHaveLength(0);
  });
});

describe("prepareMoney asking which person", () => {
  it("numbers only the people it can pick back by number, so '2' means the second person listed", async () => {
    await createUser(db, { phone: "+15550000021", handle: "sama", name: "Sam A" });
    // A claimed account with no handle can match by name, but a reply of a number is looked up by handle.
    await db.insert(users).values({ id: "usr_nohandle", phone: "+15550000022", name: "Sam B", claimedAt: new Date() });
    await createUser(db, { phone: "+15550000023", handle: "samc", name: "Sam C" });

    const reply = await prepareMoney(deps, jeremy, { kind: "send", counterparty: "sam", amountUsd: "5" });
    // Before: "1) Sam A  2) +1 555…0022  3) Sam C" with handles [sama, samc] saved, so "2" paid Sam C.
    expect(reply).toMatch(/^I found 2 people for "sam": 1\) .*@sama.*  2\) .*@samc.*\. Reply 1 or 2, or their number\.$/);
    const convo = await getConversation(db, JEREMY, deps.now());
    expect(convo?.state).toBe("awaiting_choice");
    const handles = convo?.state === "awaiting_choice" ? convo.payload.handles : [];
    expect(handles).toEqual(["sama", "samc"]);
  });
});

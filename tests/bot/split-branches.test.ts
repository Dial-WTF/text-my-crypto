import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWallet } from "@/lib/bot/accounts";
import { approveSplit, createSplit, type PreparedSplit, prepareSplit, splitStatusReply } from "@/lib/bot/split";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { intents, passkeys, type User, wallets } from "@/lib/db/schema";
import { createUnclaimedUser, createUser } from "@/lib/identity";
import { claimSplitForSettlement, declineIntent, getIntent, splitLegs } from "@/lib/intents";
import type { TransferLeg as BatchLeg } from "@/lib/settlement/capabilities";
import { optOut } from "@/lib/sms/optout";
import type { SplitCommand } from "@/lib/operator/grammar";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const JEREMY = "+15550000011";
const ALEX = "+15550000010";
const SAM = "+15550000012";
const NEWBIE = "+15550000098";
const NEWBIE2 = "+15550000099";
const TX = { txHash: "0xsplit", explorerUrl: "https://explore.test/tx/0xsplit" };

type FakeTempo = FakeAdapter & { batches: BatchLeg[][] };

/** A Tempo adapter that records each batch it would send as one transaction (as in split.test.ts). */
function fakeTempo(): FakeTempo {
  const base = fakeAdapter({ chain: "tempo", defaultBalance: 100_000_000n });
  const t: FakeTempo = Object.assign(base, {
    batches: [] as BatchLeg[][],
    batch: {
      maxLegs: 16,
      settleBatch: async ({ legs }: { legs: BatchLeg[] }) => {
        t.batches.push([...legs]);
        return TX;
      },
    },
  });
  return t;
}

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let tempo: FakeTempo;
let jeremy: User;
let alex: User;
let sam: User;

const split = (amountUsd: string, people: string[], extra: Partial<SplitCommand> = {}): SplitCommand => ({
  kind: "split",
  amountUsd,
  people,
  includeMe: false,
  ...extra,
});

/** A split between Alex and Sam, created and waiting for approval. */
async function pendingSplit(amountUsd = "30"): Promise<PreparedSplit> {
  const r = await createSplit(deps, jeremy, split(amountUsd, ["@alex", "@sam"]), [alex, sam]);
  if (!r.ok) throw new Error(r.error.message);
  return r.split;
}

const intentCount = async () => (await db.select().from(intents)).length;
const statuses = async (splitId: string) => (await splitLegs(db, splitId)).map((l) => [l.status, l.error]);

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  tempo = fakeTempo();
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }), tempo } });
  jeremy = await createUser(db, { phone: JEREMY, handle: "jeremy", name: "Jeremy" });
  alex = await createUser(db, { phone: ALEX, handle: "alex", name: "Alex" });
  sam = await createUser(db, { phone: SAM, handle: "sam", name: "Sam" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolving the people in a split", () => {
  it("stops at a name it can't place, asking for a handle or number, and creates nothing", async () => {
    expect(await prepareSplit(deps, jeremy, split("30", ["@alex", "nobody"]))).toBe(
      `I don't know who "nobody" is. Use their @handle or number in the split.`,
    );
    expect(await intentCount()).toBe(0);
  });

  it("stops at a name that matches several people, listing them", async () => {
    await createUser(db, { phone: "+15550000013", handle: "samantha", name: "Samantha" });
    // "sa" isn't anyone's handle exactly; the directory finds @sam and @samantha.
    const reply = await prepareSplit(deps, jeremy, split("30", ["@alex", "sa"]));
    expect(reply).toMatch(/^"sa" could be @sam(antha)? or @sam(antha)?\. Use their @handle in the split\.$/);
    expect(reply).toContain("@samantha");
    expect(await intentCount()).toBe(0);
  });
});

describe("createSplit", () => {
  it("refuses a named chain that can't batch even when called directly", async () => {
    const r = await createSplit(deps, jeremy, split("30", ["@alex", "@sam"], { chain: "solana" }), [alex, sam]);
    expect(r.ok ? null : r.error.code).toBe("split_chain");
    expect(await intentCount()).toBe(0);
  });

  it("refuses the same person listed twice", async () => {
    const r = await createSplit(deps, jeremy, split("30", ["@alex", "alex"]), [alex, alex]);
    expect(r).toEqual({ ok: false, error: { code: "split_people", message: "@alex is in the split twice. List each person once." } });
    expect(await intentCount()).toBe(0);
  });

  it("refuses an amount that isn't a dollar figure", async () => {
    const r = await createSplit(deps, jeremy, split("lots", ["@alex", "@sam"]), [alex, sam]);
    expect(r).toEqual({ ok: false, error: { code: "bad_amount", message: "Amounts can be from $0.01 to $50." } });
    expect(await intentCount()).toBe(0);
  });

  it("drops the missed test drip on a short sender, tells them, and goes ahead", async () => {
    // The wallet already exists (so no first-use drip this turn) and is empty.
    const mine = await ensureWallet(deps, jeremy.id, "tempo", tempo);
    tempo.balances.set(mine.address, 0n);
    const r = await createSplit(deps, jeremy, split("10", ["@alex", "@sam"]), [alex, sam]);
    expect(r.ok).toBe(true);
    expect(tempo.funded).toEqual([`${mine.address}:25000000`]);
    expect(sms.last(JEREMY)).toMatch(/^Dial is on testnet for now, so I put \$25 .*in your wallet to try it\./);
    expect(await intentCount()).toBe(2);
  });

  it("asks for the passkey instead of a code when the total is over the threshold", async () => {
    await db.insert(passkeys).values({ id: "pk_1", userId: jeremy.id, publicKey: "pk" });
    // $30 in all is over the $20 passkey threshold, though each $15 share is under it.
    const p = await pendingSplit("30");
    expect(p.code).toBeNull();
    expect(p.legs.map((l) => l.intent.codeHash)).toEqual([null, null]);

    // Under the threshold the same account still gets a code.
    const small = await createSplit(deps, jeremy, split("10", ["@alex", "@sam"]), [alex, sam]);
    expect(small.ok && small.split.code).toMatch(/^\d{6}$/);
  });
});

describe("approveSplit", () => {
  it("fails every claimed leg when one was declined on its own since, and moves nothing", async () => {
    const p = await pendingSplit();
    const [first, second] = p.legs;
    expect(await declineIntent(db, second!.intent.id)).toBe(true);
    expect(await approveSplit(deps, p.splitId)).toEqual({ ok: false, reason: "failed", error: "Split changed before approval" });
    expect((await getIntent(db, first!.intent.id))?.status).toBe("failed");
    expect(tempo.batches).toHaveLength(0);
  });

  it("fails when a recipient's account is gone", async () => {
    const p = await pendingSplit();
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.update(intents).set({ recipientId: "usr_gone" }).where(eq(intents.id, p.legs[1]!.intent.id));
    expect(await approveSplit(deps, p.splitId)).toEqual({ ok: false, reason: "failed", error: "Missing recipient" });
    expect(await statuses(p.splitId)).toEqual([
      ["failed", "Missing recipient"],
      ["failed", "Missing recipient"],
    ]);
    expect(tempo.batches).toHaveLength(0);
  });

  it("fails, and tells the sender, when the chain lost its batch settlement before approval", async () => {
    const p = await pendingSplit();
    const solanaOnly = { ...deps, adapters: { solana: fakeAdapter() } };
    expect(await approveSplit(solanaOnly, p.splitId)).toEqual({ ok: false, reason: "failed", error: "No batch settlement on tempo" });
    expect(sms.last(JEREMY)).toBe("That payment didn't go through. No funds moved.");
    expect(await statuses(p.splitId)).toEqual([
      ["failed", "No batch settlement on tempo"],
      ["failed", "No batch settlement on tempo"],
    ]);
  });

  it("fails when the sender's wallet is missing", async () => {
    const p = await pendingSplit();
    await db.delete(wallets).where(eq(wallets.userId, jeremy.id));
    expect(await approveSplit(deps, p.splitId)).toEqual({ ok: false, reason: "failed", error: "Missing sender wallet" });
    expect(sms.last(JEREMY)).toBe("That payment didn't go through. No funds moved.");
    expect(tempo.batches).toHaveLength(0);
  });

  it("holds every share when nobody is on Dial yet, and doesn't text a newcomer who opted out", async () => {
    const a = await createUnclaimedUser(db, NEWBIE);
    const b = await createUnclaimedUser(db, NEWBIE2);
    await optOut(db, NEWBIE2, deps.now());
    const r = await createSplit(deps, jeremy, split("20", [NEWBIE, NEWBIE2]), [a, b]);
    if (!r.ok) throw new Error(r.error.message);

    const out = await approveSplit(deps, r.split.splitId);
    expect(out).toEqual({ ok: true, status: "escrowed", ...TX });
    expect((await statuses(r.split.splitId)).map(([s]) => s)).toEqual(["escrowed", "escrowed"]);
    expect(sms.to(NEWBIE)).toHaveLength(1);
    expect(sms.last(NEWBIE)).toMatch(/^Jeremy sent you \$10 .*on Dial\. Reply to this text to claim it\./);
    expect(sms.to(NEWBIE2)).toEqual([]);
    expect(sms.last(JEREMY)).toMatch(/have 7 days to claim\. Receipt: https:\/\/explore\.test\/tx\/0xsplit$/);
  });
});

describe("splitStatusReply", () => {
  it("defers to the plain status for a pending split when there's no fresh code to give, or it expired", async () => {
    const p = await pendingSplit();
    const leg = p.legs[0]!.intent;
    expect(await splitStatusReply(deps, jeremy, leg, { freshCode: false })).toBeNull();
    const later = { ...deps, now: () => new Date(leg.expiresAt.getTime() + 1) };
    expect(await splitStatusReply(later, jeremy, leg, { freshCode: true })).toBeNull();
    // Contrast: with a fresh code allowed, it answers for the whole split.
    expect(await splitStatusReply(deps, jeremy, leg, { freshCode: true })).toMatch(/^Still waiting on you: your \$30 split/);
  });

  it("says a split being sent is on its way", async () => {
    const p = await pendingSplit();
    const [claimed] = await claimSplitForSettlement(db, p.splitId, deps.now());
    expect(claimed?.status).toBe("settling");
    expect(await splitStatusReply(deps, jeremy, claimed!, { freshCode: true })).toBe(
      "Sending your $30 split now. I'll text you the receipt.",
    );
  });

  it("defers to the plain status when a recipient's account is gone", async () => {
    const p = await pendingSplit();
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.update(intents).set({ recipientId: "usr_gone" }).where(eq(intents.id, p.legs[1]!.intent.id));
    expect(await splitStatusReply(deps, jeremy, p.legs[0]!.intent, { freshCode: true })).toBeNull();
  });
});

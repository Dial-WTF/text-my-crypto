import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import {
  claimUser,
  consumeSignupToken,
  createSignupToken,
  createUnclaimedUser,
  createUser,
  displayName,
  isClaimed,
  peekSignupToken,
  resolveRecipient,
} from "@/lib/identity";
import { addWallet, getWallet, unsealWallet } from "@/lib/wallets";
import { createTestDb } from "./helpers/db";

const key = Buffer.alloc(32, 3).toString("base64");
const now = new Date("2026-10-09T12:00:00Z");
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("identity", () => {
  it("resolves by handle (case/@-insensitive) and by phone in any format", async () => {
    const u = await createUser(db, { phone: "+18066071387", handle: "jeremy" });
    expect((await resolveRecipient(db, "jeremy"))?.id).toBe(u.id);
    expect((await resolveRecipient(db, "@Jeremy"))?.id).toBe(u.id);
    expect((await resolveRecipient(db, "(806) 607-1387"))?.id).toBe(u.id);
    expect(await resolveRecipient(db, "nobody")).toBeNull();
  });

  it("signup tokens are single-use and expire", async () => {
    const t = await createSignupToken(db, "+15550000002", now);
    expect(await peekSignupToken(db, t, now)).toBe("+15550000002");
    expect(await consumeSignupToken(db, t, now)).toBe("+15550000002");
    expect(await consumeSignupToken(db, t, now)).toBeNull();

    const t2 = await createSignupToken(db, "+15550000003", now);
    const later = new Date(now.getTime() + 16 * 60_000);
    expect(await consumeSignupToken(db, t2, later)).toBeNull();
  });

  it("stores wallet secrets sealed and unseals them", async () => {
    const u = await createUser(db, { phone: "+15550000004", handle: "sam" });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await addWallet(db, { userId: u.id, chain: "solana", address: "Addr111", secret, keyB64: key });
    const w = await getWallet(db, u.id, "solana");
    if (!w) throw new Error("wallet missing");
    expect(w.address).toBe("Addr111");
    expect(w.secretEnc).not.toContain("Addr111");
    expect(await unsealWallet(w, key)).toEqual(secret);
    expect(await getWallet(db, u.id, "tempo")).toBeNull();
  });
});

describe("unclaimed users", () => {
  it("creates a nameless user that can be claimed once", async () => {
    const u = await createUnclaimedUser(db, "+15550000050");
    expect(isClaimed(u)).toBe(false);
    expect(displayName(u)).toBe("+•••••••0050");
    expect((await resolveRecipient(db, "555 000 0050"))?.id).toBe(u.id);

    const claimed = await claimUser(db, u.id, "riley", now);
    expect(claimed?.handle).toBe("riley");
    expect(claimed && isClaimed(claimed)).toBe(true);
    expect(await claimUser(db, u.id, "other", now)).toBeNull();
    expect(displayName(claimed!)).toBe("riley");
  });
});

import { describe, expect, it } from "vitest";
import { createUser } from "@/lib/identity";
import {
  createSession,
  endSession,
  endSessionsForUser,
  issueWalletCode,
  loginLinkOpen,
  redeemLoginLink,
  redeemWalletCode,
  SESSION_TTL_MS,
  sessionUser,
} from "@/lib/web/sessions";
import { createTestDb } from "../helpers/db";

const now = new Date("2026-10-09T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

async function setup() {
  const db = await createTestDb();
  const user = await createUser(db, { phone: "+15550000301", handle: "alex" }, now);
  return { db, user };
}

describe("wallet codes (/@handle/wallet)", () => {
  it("a right code signs in once, with or without a space, and is burned", async () => {
    const { db, user } = await setup();
    const { code } = await issueWalletCode(db, user.id, now);
    expect(await redeemWalletCode(db, user.id, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toEqual({ ok: true, userId: user.id });
    expect(await redeemWalletCode(db, user.id, code, now)).toEqual({ ok: false, reason: "closed" });
  });

  it("issuing a code closes the account's older ones, so only the newest works", async () => {
    const { db, user } = await setup();
    const first = await issueWalletCode(db, user.id, now);
    const second = await issueWalletCode(db, user.id, later(60_000));
    const newest = await issueWalletCode(db, user.id, later(120_000));
    expect(await loginLinkOpen(db, first.token, later(120_000))).toBe(false);
    expect(await loginLinkOpen(db, second.token, later(120_000))).toBe(false);
    expect(await redeemLoginLink(db, first.token, first.code, later(120_000))).toEqual({ ok: false, reason: "closed" });
    if (second.code !== newest.code) {
      expect(await redeemWalletCode(db, user.id, second.code, later(120_000))).toEqual({ ok: false, reason: "bad_code" });
    }
    expect(await redeemWalletCode(db, user.id, newest.code, later(120_000))).toEqual({ ok: true, userId: user.id });
  });

  it("codes issued in the same millisecond, one after another or at once, leave exactly one open", async () => {
    const { db, user } = await setup();
    for (let i = 0; i < 10; i++) {
      const a = await issueWalletCode(db, user.id, now);
      const b = await issueWalletCode(db, user.id, now);
      expect([await loginLinkOpen(db, a.token, now), await loginLinkOpen(db, b.token, now)]).toEqual([false, true]);
      const together = await Promise.all([issueWalletCode(db, user.id, now), issueWalletCode(db, user.id, now)]);
      const open = await Promise.all(together.map((c) => loginLinkOpen(db, c.token, now)));
      expect(open.filter(Boolean)).toHaveLength(1);
    }
  });

  it("issuing a code leaves other accounts' codes open, and a code only opens its own account", async () => {
    const { db, user } = await setup();
    const other = await createUser(db, { phone: "+15550000302", handle: "sam" }, now);
    const theirs = await issueWalletCode(db, other.id, now);
    const mine = await issueWalletCode(db, user.id, now);
    if (theirs.code !== mine.code) {
      expect(await redeemWalletCode(db, user.id, theirs.code, now)).toEqual({ ok: false, reason: "bad_code" });
    }
    expect(await redeemWalletCode(db, other.id, theirs.code, now)).toEqual({ ok: true, userId: other.id });
    expect(await redeemWalletCode(db, user.id, mine.code, now)).toEqual({ ok: true, userId: user.id });
  });

  it("closes after five wrong codes or fifteen minutes", async () => {
    const { db, user } = await setup();
    const a = await issueWalletCode(db, user.id, now);
    for (let i = 0; i < 5; i++) expect(await redeemWalletCode(db, user.id, wrongFor(a.code), now)).toEqual({ ok: false, reason: "bad_code" });
    expect(await redeemWalletCode(db, user.id, a.code, now)).toEqual({ ok: false, reason: "closed" });

    const b = await issueWalletCode(db, user.id, now);
    expect(await redeemWalletCode(db, user.id, b.code, later(15 * 60_000))).toEqual({ ok: false, reason: "closed" });
  });

  it("holds the five-try limit against parallel guesses", async () => {
    const { db, user } = await setup();
    const { code } = await issueWalletCode(db, user.id, now);
    const wrong = Array.from({ length: 12 }, (_, n) => String((Number(code) + n + 1) % 1_000_000).padStart(6, "0"));
    const results = await Promise.all(wrong.map((c) => redeemWalletCode(db, user.id, c, now)));
    expect(results.filter((r) => !r.ok && r.reason === "bad_code")).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "closed")).toHaveLength(7);
    expect(await redeemWalletCode(db, user.id, code, now)).toEqual({ ok: false, reason: "closed" });
  });

  it("lets the right code through on the fifth try", async () => {
    const { db, user } = await setup();
    const { code } = await issueWalletCode(db, user.id, now);
    for (let i = 0; i < 4; i++) await redeemWalletCode(db, user.id, wrongFor(code), now);
    expect(await redeemWalletCode(db, user.id, code, now)).toEqual({ ok: true, userId: user.id });
  });

  it("says closed when no code was ever issued", async () => {
    const { db, user } = await setup();
    expect(await redeemWalletCode(db, user.id, "123456", now)).toEqual({ ok: false, reason: "closed" });
  });
});

describe("legacy /wallet/in/<token> links", () => {
  it("need the texted code, work once, and accept the code with a space", async () => {
    const { db, user } = await setup();
    const { token, code } = await issueWalletCode(db, user.id, now);
    expect(await loginLinkOpen(db, token, now)).toBe(true);
    expect(await redeemLoginLink(db, token, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toEqual({ ok: true, userId: user.id });
    expect(await loginLinkOpen(db, token, now)).toBe(false);
    expect(await redeemLoginLink(db, token, code, now)).toEqual({ ok: false, reason: "closed" });
  });

  it("close after five wrong codes or fifteen minutes", async () => {
    const { db, user } = await setup();
    const a = await issueWalletCode(db, user.id, now);
    for (let i = 0; i < 5; i++) expect(await redeemLoginLink(db, a.token, wrongFor(a.code), now)).toEqual({ ok: false, reason: "bad_code" });
    expect(await redeemLoginLink(db, a.token, a.code, now)).toEqual({ ok: false, reason: "closed" });

    const b = await issueWalletCode(db, user.id, now);
    expect(await loginLinkOpen(db, b.token, later(15 * 60_000))).toBe(false);
    expect(await redeemLoginLink(db, b.token, b.code, later(15 * 60_000))).toEqual({ ok: false, reason: "closed" });
  });

  it("hold the five-try limit against parallel guesses", async () => {
    const { db, user } = await setup();
    const { token, code } = await issueWalletCode(db, user.id, now);
    const wrong = Array.from({ length: 12 }, (_, n) => String((Number(code) + n + 1) % 1_000_000).padStart(6, "0"));
    const results = await Promise.all(wrong.map((c) => redeemLoginLink(db, token, c, now)));
    expect(results.filter((r) => !r.ok && r.reason === "bad_code")).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "closed")).toHaveLength(7);
    expect(await redeemLoginLink(db, token, code, now)).toEqual({ ok: false, reason: "closed" });
    expect(await loginLinkOpen(db, token, now)).toBe(false);
  });

  it("an old link is closed by a newer WALLET text", async () => {
    const { db, user } = await setup();
    const old = await issueWalletCode(db, user.id, now);
    await issueWalletCode(db, user.id, later(1000));
    expect(await redeemLoginLink(db, old.token, old.code, later(1000))).toEqual({ ok: false, reason: "closed" });
  });
});

describe("web sessions", () => {
  it("finds the user until sign-out or expiry, and ignores junk cookies", async () => {
    const { db, user } = await setup();
    const token = await createSession(db, user.id, "text", now);
    expect((await sessionUser(db, token, now))?.id).toBe(user.id);
    expect(await sessionUser(db, token, later(SESSION_TTL_MS))).toBeNull();
    expect(await sessionUser(db, "nope", now)).toBeNull();
    expect(await sessionUser(db, undefined, now)).toBeNull();
    await endSession(db, token, now);
    expect(await sessionUser(db, token, now)).toBeNull();
  });

  it("ends every session and open wallet code for one account, and only that account", async () => {
    const { db, user } = await setup();
    const other = await createUser(db, { phone: "+15550000302", handle: "sam" }, now);
    const a = await createSession(db, user.id, "text", now);
    const b = await createSession(db, user.id, "passkey", now);
    const theirs = await createSession(db, other.id, "text", now);
    const link = await issueWalletCode(db, user.id, now);

    expect(await endSessionsForUser(db, user.id, now)).toBe(2);
    expect(await sessionUser(db, a, now)).toBeNull();
    expect(await sessionUser(db, b, now)).toBeNull();
    expect((await sessionUser(db, theirs, now))?.id).toBe(other.id);
    expect(await redeemWalletCode(db, user.id, link.code, now)).toEqual({ ok: false, reason: "closed" });
    expect(await endSessionsForUser(db, user.id, now)).toBe(0);
  });
});

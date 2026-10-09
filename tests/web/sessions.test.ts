import { describe, expect, it } from "vitest";
import { createUser } from "@/lib/identity";
import {
  createSession,
  endSession,
  endSessionsForUser,
  loginLinkOpen,
  redeemLoginLink,
  SESSION_TTL_MS,
  sessionUser,
  startLoginLink,
} from "@/lib/web/sessions";
import { createTestDb } from "../helpers/db";

const now = new Date("2026-10-09T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

async function setup() {
  const db = await createTestDb();
  const user = await createUser(db, { phone: "+15550000301", handle: "alex" }, now);
  return { db, user };
}

describe("wallet sign-in links", () => {
  it("needs the texted code, works once, and accepts the code with a space", async () => {
    const { db, user } = await setup();
    const { token, code } = await startLoginLink(db, user.id, now);
    expect(await loginLinkOpen(db, token, now)).toBe(true);
    expect(await redeemLoginLink(db, token, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toEqual({ ok: true, userId: user.id });
    expect(await loginLinkOpen(db, token, now)).toBe(false);
    expect(await redeemLoginLink(db, token, code, now)).toEqual({ ok: false, reason: "closed" });
  });

  it("closes after five wrong codes or fifteen minutes", async () => {
    const { db, user } = await setup();
    const a = await startLoginLink(db, user.id, now);
    const wrong = a.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await redeemLoginLink(db, a.token, wrong, now)).toEqual({ ok: false, reason: "bad_code" });
    expect(await redeemLoginLink(db, a.token, a.code, now)).toEqual({ ok: false, reason: "closed" });

    const b = await startLoginLink(db, user.id, now);
    expect(await loginLinkOpen(db, b.token, later(15 * 60_000))).toBe(false);
    expect(await redeemLoginLink(db, b.token, b.code, later(15 * 60_000))).toEqual({ ok: false, reason: "closed" });
  });

  it("holds the five-try limit against parallel guesses", async () => {
    const { db, user } = await setup();
    const { token, code } = await startLoginLink(db, user.id, now);
    const wrong = Array.from({ length: 12 }, (_, n) => String((Number(code) + n + 1) % 1_000_000).padStart(6, "0"));
    const results = await Promise.all(wrong.map((c) => redeemLoginLink(db, token, c, now)));
    expect(results.filter((r) => !r.ok && r.reason === "bad_code")).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "closed")).toHaveLength(7);
    expect(await redeemLoginLink(db, token, code, now)).toEqual({ ok: false, reason: "closed" });
    expect(await loginLinkOpen(db, token, now)).toBe(false);
  });

  it("lets the right code through on the fifth try", async () => {
    const { db, user } = await setup();
    const { token, code } = await startLoginLink(db, user.id, now);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await redeemLoginLink(db, token, wrong, now);
    expect(await redeemLoginLink(db, token, code, now)).toEqual({ ok: true, userId: user.id });
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

  it("ends every session and open sign-in link for one account, and only that account", async () => {
    const { db, user } = await setup();
    const other = await createUser(db, { phone: "+15550000302", handle: "sam" }, now);
    const a = await createSession(db, user.id, "text", now);
    const b = await createSession(db, user.id, "passkey", now);
    const theirs = await createSession(db, other.id, "text", now);
    const link = await startLoginLink(db, user.id, now);

    expect(await endSessionsForUser(db, user.id, now)).toBe(2);
    expect(await sessionUser(db, a, now)).toBeNull();
    expect(await sessionUser(db, b, now)).toBeNull();
    expect((await sessionUser(db, theirs, now))?.id).toBe(other.id);
    expect(await redeemLoginLink(db, link.token, link.code, now)).toEqual({ ok: false, reason: "closed" });
    expect(await endSessionsForUser(db, user.id, now)).toBe(0);
  });
});

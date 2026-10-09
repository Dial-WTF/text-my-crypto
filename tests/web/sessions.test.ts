import { describe, expect, it } from "vitest";
import { createUser } from "@/lib/identity";
import {
  createSession,
  endSession,
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
});

import { describe, expect, it } from "vitest";
import { passkeyChallenges } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { createIntent } from "@/lib/intents";
import {
  LOGIN_CHALLENGE_TTL_MS,
  relyingParty,
  startApproval,
  startPasskeyLogin,
  verifyApproval,
  verifyPasskeyLogin,
} from "@/lib/passkeys";
import { fakeAuthenticator } from "../helpers/authenticator";
import { createTestDb } from "../helpers/db";

const now = new Date("2026-10-09T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const rp = relyingParty("https://tmc.test");

async function setup() {
  const db = await createTestDb();
  const user = await createUser(db, { phone: "+15550000501", handle: "alex" }, now);
  const passkey = fakeAuthenticator(rp);
  await passkey.register(db, user.id);
  return { db, user, passkey };
}

describe("passkey sign-in", () => {
  it("signs in with a challenge the server issued, once", async () => {
    const { db, user, passkey } = await setup();
    const { options, challengeId } = await startPasskeyLogin(db, rp, now);
    const assertion = passkey.assert(options.challenge);
    expect(await verifyPasskeyLogin(db, rp, challengeId, assertion, now)).toBe(user.id);

    // Replaying the same assertion, with the same cookie or a fresh one, gets nothing.
    expect(await verifyPasskeyLogin(db, rp, challengeId, assertion, now)).toBeNull();
    const fresh = await startPasskeyLogin(db, rp, now);
    expect(await verifyPasskeyLogin(db, rp, fresh.challengeId, assertion, now)).toBeNull();
  });

  it("keeps the challenge on the server and hands the browser only an opaque id", async () => {
    const { db } = await setup();
    const { options, challengeId } = await startPasskeyLogin(db, rp, now);
    expect(challengeId).not.toBe(options.challenge);
    const rows = await db.select().from(passkeyChallenges);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.challenge).toBe(options.challenge);
    expect(JSON.stringify(rows)).not.toContain(challengeId);
  });

  it("rejects a missing or unknown challenge id", async () => {
    const { db, passkey } = await setup();
    const { options } = await startPasskeyLogin(db, rp, now);
    const assertion = passkey.assert(options.challenge);
    expect(await verifyPasskeyLogin(db, rp, undefined, assertion, now)).toBeNull();
    expect(await verifyPasskeyLogin(db, rp, "made-up", assertion, now)).toBeNull();
  });

  it("spends the challenge on a failed try too", async () => {
    const { db, passkey } = await setup();
    const { options, challengeId } = await startPasskeyLogin(db, rp, now);
    const other = await startPasskeyLogin(db, rp, now);
    expect(await verifyPasskeyLogin(db, rp, challengeId, passkey.assert(other.options.challenge), now)).toBeNull();
    expect(await verifyPasskeyLogin(db, rp, challengeId, passkey.assert(options.challenge), now)).toBeNull();
  });

  it("expires challenges after five minutes and clears old ones out", async () => {
    const { db, passkey } = await setup();
    const { options, challengeId } = await startPasskeyLogin(db, rp, now);
    expect(await verifyPasskeyLogin(db, rp, challengeId, passkey.assert(options.challenge), later(LOGIN_CHALLENGE_TTL_MS))).toBeNull();

    await startPasskeyLogin(db, rp, now);
    await startPasskeyLogin(db, rp, later(LOGIN_CHALLENGE_TTL_MS));
    expect(await db.select().from(passkeyChallenges)).toHaveLength(1);
  });

  it("never accepts a payment approval as a sign-in, or a sign-in as an approval", async () => {
    const { db, user, passkey } = await setup();
    const bob = await createUser(db, { phone: "+15550000502", handle: "bob" }, now);
    const intent = await createIntent(
      db,
      { kind: "send", createdBy: user.id, senderId: user.id, recipientId: bob.id, chain: "solana", token: "M", recipientAddress: "E", amount: 25_000_000n, note: null },
      now,
    );

    const approval = await startApproval(db, rp, intent);
    const approvalAssertion = passkey.assert(approval.challenge);
    const { challengeId } = await startPasskeyLogin(db, rp, now);
    expect(await verifyPasskeyLogin(db, rp, challengeId, approvalAssertion, now)).toBeNull();

    const login = await startPasskeyLogin(db, rp, now);
    expect(await verifyApproval(db, rp, intent, passkey.assert(login.options.challenge))).toBe(false);
    expect(await verifyApproval(db, rp, intent, passkey.assert(approval.challenge))).toBe(true);
  });
});

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { type Intent, type Passkey, passkeyChallenges, passkeys, signupTokens } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { intentHash, splitHash, splitLegs } from "@/lib/intents";
import { randomToken } from "@/lib/ids";

export type RelyingParty = { rpID: string; origin: string; rpName: string };

export function relyingParty(appUrl: string): RelyingParty {
  const u = new URL(appUrl);
  return { rpID: u.hostname, origin: u.origin, rpName: "Dial" };
}

const transportsSchema = z.array(z.string());

async function listPasskeys(db: Db, userId: string): Promise<Passkey[]> {
  return db.select().from(passkeys).where(eq(passkeys.userId, userId));
}

export async function hasPasskey(db: Db, userId: string): Promise<boolean> {
  return (await listPasskeys(db, userId)).length > 0;
}

/** Registration options for the phone behind a signup token. The challenge is stored on the token row. */
export async function startRegistration(
  db: Db,
  rp: RelyingParty,
  token: string,
  user: { id: string; name: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await listPasskeys(db, user.id);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: existing.map((p) => ({ id: p.id })),
  });
  await db.update(signupTokens).set({ challenge: options.challenge }).where(eq(signupTokens.token, token));
  return options;
}

export async function finishRegistration(
  db: Db,
  rp: RelyingParty,
  token: string,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<boolean> {
  const [row] = await db.select().from(signupTokens).where(eq(signupTokens.token, token)).limit(1);
  if (!row?.challenge) return false;
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: row.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  });
  await db.update(signupTokens).set({ challenge: null }).where(eq(signupTokens.token, token));
  if (!verification.verified) return false;
  const { credential } = verification.registrationInfo;
  await db.insert(passkeys).values({
    id: credential.id,
    userId,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports ?? []),
  });
  return true;
}

/** The challenge is the intent hash (for a split, the hash over every leg), so the signature covers exactly this payment. */
async function intentChallenge(db: Db, intent: Intent): Promise<Uint8Array<ArrayBuffer>> {
  const hex = intent.splitId ? await splitHash(await splitLegs(db, intent.splitId)) : await intentHash(intent);
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

export async function startApproval(
  db: Db,
  rp: RelyingParty,
  intent: Intent,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const keys = await listPasskeys(db, intent.senderId);
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: await intentChallenge(db, intent),
    userVerification: "required",
    allowCredentials: keys.map((k) => ({ id: k.id, transports: transportsSchema.parse(JSON.parse(k.transports)) })),
  });
}

/** Verifies a passkey assertion over this intent by one of the payer's own passkeys. */
export async function verifyApproval(
  db: Db,
  rp: RelyingParty,
  intent: Intent,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const [key] = await db
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, response.id), eq(passkeys.userId, intent.senderId)))
    .limit(1);
  if (!key) return false;
  return verifyAssertion(db, rp, key, response, isoBase64URL.fromBuffer(await intentChallenge(db, intent)));
}

/** Checks one assertion by a stored passkey against the expected challenge, and bumps its counter. */
async function verifyAssertion(
  db: Db,
  rp: RelyingParty,
  key: Passkey,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<boolean> {
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
    credential: {
      id: key.id,
      publicKey: isoBase64URL.toBuffer(key.publicKey),
      counter: key.counter,
      transports: transportsSchema.parse(JSON.parse(key.transports)),
    },
  }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
  if (!verification.verified) return false;
  await db
    .update(passkeys)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(passkeys.id, key.id));
  return true;
}

export const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Every sign-in challenge starts with these bytes. An approval challenge is a bare 32-byte intent
 * hash, so an assertion made to approve a payment can never pass as a sign-in, or the other way round.
 */
const LOGIN_CHALLENGE_PREFIX = new TextEncoder().encode("dial-login-v1:");

const hashChallengeId = (id: string) => sha256Hex(`dial-passkey-challenge-v1|${id}`);

function newLoginChallenge(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(LOGIN_CHALLENGE_PREFIX.length + 32);
  out.set(LOGIN_CHALLENGE_PREFIX);
  crypto.getRandomValues(out.subarray(LOGIN_CHALLENGE_PREFIX.length));
  return out;
}

function isLoginChallenge(challenge: string): boolean {
  const bytes = isoBase64URL.toBuffer(challenge);
  return (
    bytes.length === LOGIN_CHALLENGE_PREFIX.length + 32 && LOGIN_CHALLENGE_PREFIX.every((b, i) => bytes[i] === b)
  );
}

export type PasskeyLogin = { options: PublicKeyCredentialRequestOptionsJSON; challengeId: string };

/**
 * Options for signing in with whichever passkey this device offers. The challenge is random and kept
 * server-side for five minutes; the caller hands the browser only the opaque `challengeId` (a cookie)
 * and passes it back to verifyPasskeyLogin.
 */
export async function startPasskeyLogin(db: Db, rp: RelyingParty, now: Date): Promise<PasskeyLogin> {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: newLoginChallenge(),
    userVerification: "required",
    allowCredentials: [],
  });
  const challengeId = randomToken(24);
  await db.delete(passkeyChallenges).where(lte(passkeyChallenges.expiresAt, now));
  await db.insert(passkeyChallenges).values({
    idHash: await hashChallengeId(challengeId),
    purpose: "login",
    challenge: options.challenge,
    expiresAt: new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS),
  });
  return { options, challengeId };
}

/** Removes a sign-in challenge and returns it, or null if it was never issued, already used or expired. */
async function takeLoginChallenge(db: Db, challengeId: string, now: Date): Promise<string | null> {
  const [row] = await db
    .delete(passkeyChallenges)
    .where(and(eq(passkeyChallenges.idHash, await hashChallengeId(challengeId)), eq(passkeyChallenges.purpose, "login")))
    .returning({ challenge: passkeyChallenges.challenge, expiresAt: passkeyChallenges.expiresAt });
  if (!row || row.expiresAt <= now || !isLoginChallenge(row.challenge)) return null;
  return row.challenge;
}

/**
 * The account that owns the passkey behind a valid sign-in assertion, or null. The challenge is
 * spent on the first try, right or wrong, so a captured assertion can't be replayed.
 */
export async function verifyPasskeyLogin(
  db: Db,
  rp: RelyingParty,
  challengeId: string | undefined,
  response: AuthenticationResponseJSON,
  now: Date,
): Promise<string | null> {
  if (!challengeId) return null;
  const challenge = await takeLoginChallenge(db, challengeId, now);
  if (!challenge) return null;
  const [key] = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).limit(1);
  if (!key) return null;
  return (await verifyAssertion(db, rp, key, response, challenge)) ? key.userId : null;
}

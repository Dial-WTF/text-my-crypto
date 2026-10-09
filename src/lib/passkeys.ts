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
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { type Intent, type Passkey, passkeys, signupTokens } from "@/lib/db/schema";
import { intentHash } from "@/lib/intents";

export type RelyingParty = { rpID: string; origin: string; rpName: string };

export function relyingParty(appUrl: string): RelyingParty {
  const u = new URL(appUrl);
  return { rpID: u.hostname, origin: u.origin, rpName: "Dial" };
}

const transportsSchema = z.array(z.string());

export async function listPasskeys(db: Db, userId: string): Promise<Passkey[]> {
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

/** The challenge is the intent hash, so the signature covers exactly this payment. */
async function intentChallenge(intent: Intent): Promise<Uint8Array<ArrayBuffer>> {
  const hex = await intentHash(intent);
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
    challenge: await intentChallenge(intent),
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
  return verifyAssertion(db, rp, key, response, isoBase64URL.fromBuffer(await intentChallenge(intent)));
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
  if (!verification.verified || !verification.authenticationInfo) return false;
  await db
    .update(passkeys)
    .set({ counter: verification.authenticationInfo.newCounter })
    .where(eq(passkeys.id, key.id));
  return true;
}

/**
 * Options for signing in with whichever passkey this device offers. The challenge is random; the
 * caller keeps it (a short-lived cookie) and hands it back to verifyPasskeyLogin.
 */
export function startPasskeyLogin(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
}

/** The account that owns the passkey behind a valid sign-in assertion, or null. */
export async function verifyPasskeyLogin(
  db: Db,
  rp: RelyingParty,
  challenge: string,
  response: AuthenticationResponseJSON,
): Promise<string | null> {
  const [key] = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).limit(1);
  if (!key) return null;
  return (await verifyAssertion(db, rp, key, response, challenge)) ? key.userId : null;
}

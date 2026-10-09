"use server";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revokeAgentKey } from "@/lib/agents/keys";
import { botDeps } from "@/lib/deps";
import { LOGIN_CHALLENGE_TTL_MS, relyingParty, startPasskeyLogin, verifyPasskeyLogin } from "@/lib/passkeys";
import { currentUser, SESSION_COOKIE_OPTIONS } from "@/lib/web/current";
import { createSession, endSession, SESSION_COOKIE } from "@/lib/web/sessions";
import { formText } from "@/lib/form";

const CHALLENGE_COOKIE = "dial_passkey_challenge";

async function startSession(userId: string, via: "text" | "passkey"): Promise<void> {
  const deps = botDeps();
  const token = await createSession(deps.db, userId, via, deps.now());
  (await cookies()).set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
}

/** The challenge itself stays on the server; the cookie only names it. */
export async function passkeyOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const deps = botDeps();
  const { options, challengeId } = await startPasskeyLogin(deps.db, relyingParty(deps.appUrl), deps.now());
  (await cookies()).set(CHALLENGE_COOKIE, challengeId, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: LOGIN_CHALLENGE_TTL_MS / 1000,
  });
  return options;
}

export async function passkeyFinish(response: AuthenticationResponseJSON): Promise<{ ok: boolean }> {
  const jar = await cookies();
  const challengeId = jar.get(CHALLENGE_COOKIE)?.value;
  jar.delete(CHALLENGE_COOKIE);
  if (!challengeId) return { ok: false };
  const deps = botDeps();
  const userId = await verifyPasskeyLogin(deps.db, relyingParty(deps.appUrl), challengeId, response, deps.now());
  if (!userId) return { ok: false };
  await startSession(userId, "passkey");
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await endSession(botDeps().db, token, new Date());
  jar.delete(SESSION_COOKIE);
  redirect("/wallet");
}

export async function revokeAgent(form: FormData): Promise<void> {
  const user = await currentUser();
  if (user) await revokeAgentKey(botDeps().db, user.id, formText(form, "id"), new Date());
  redirect("/wallet");
}

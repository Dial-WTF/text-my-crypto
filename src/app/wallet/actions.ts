"use server";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revokeAgentKey } from "@/lib/agents/keys";
import { botDeps } from "@/lib/deps";
import { relyingParty, startPasskeyLogin, verifyPasskeyLogin } from "@/lib/passkeys";
import { currentUser, SESSION_COOKIE_OPTIONS } from "@/lib/web/current";
import { createSession, endSession, redeemLoginLink, SESSION_COOKIE } from "@/lib/web/sessions";

const CHALLENGE_COOKIE = "dial_passkey_challenge";

async function startSession(userId: string, via: "text" | "passkey"): Promise<void> {
  const deps = botDeps();
  const token = await createSession(deps.db, userId, via, deps.now());
  (await cookies()).set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
}

/** The texted link's form: the code from the same text opens the wallet. */
export async function signInWithCode(form: FormData): Promise<void> {
  const token = String(form.get("token") ?? "");
  const code = String(form.get("code") ?? "");
  const deps = botDeps();
  const r = await redeemLoginLink(deps.db, token, code, deps.now());
  if (!r.ok) redirect(`/wallet/in/${encodeURIComponent(token)}${r.reason === "bad_code" ? "?error=code" : ""}`);
  await startSession(r.userId, "text");
  redirect("/wallet");
}

export async function passkeyOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await startPasskeyLogin(relyingParty(botDeps().appUrl));
  (await cookies()).set(CHALLENGE_COOKIE, options.challenge, { ...SESSION_COOKIE_OPTIONS, maxAge: 300 });
  return options;
}

export async function passkeyFinish(response: AuthenticationResponseJSON): Promise<{ ok: boolean }> {
  const jar = await cookies();
  const challenge = jar.get(CHALLENGE_COOKIE)?.value;
  jar.delete(CHALLENGE_COOKIE);
  if (!challenge) return { ok: false };
  const deps = botDeps();
  const userId = await verifyPasskeyLogin(deps.db, relyingParty(deps.appUrl), challenge, response);
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
  if (user) await revokeAgentKey(botDeps().db, user.id, String(form.get("id") ?? ""), new Date());
  redirect("/wallet");
}

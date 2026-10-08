"use server";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { notify } from "@/lib/bot/text";
import { botDeps } from "@/lib/deps";
import { consumeSignupToken, findUserByPhone, isClaimed, peekSignupToken } from "@/lib/identity";
import { finishRegistration, startRegistration } from "@/lib/passkeys";
import { rp } from "@/lib/web";
import type { ActionResult } from "@/ui/patterns/ApprovePanel/ApprovePanel";

async function accountFor(token: string) {
  const { db } = botDeps();
  const phone = await peekSignupToken(db, token, new Date());
  const user = phone ? await findUserByPhone(db, phone) : null;
  return user && isClaimed(user) ? user : null;
}

export async function beginPasskeySetup(token: string): Promise<PublicKeyCredentialCreationOptionsJSON | null> {
  const user = await accountFor(token);
  if (!user?.handle) return null;
  return startRegistration(botDeps().db, rp(), token, { id: user.id, name: user.handle });
}

export async function finishPasskeySetup(token: string, response: RegistrationResponseJSON): Promise<ActionResult> {
  const deps = botDeps();
  const user = await accountFor(token);
  if (!user) return { ok: false, message: "This link expired. Text “upgrade” to the operator for a new one." };
  const ok = await finishRegistration(deps.db, rp(), token, user.id, response).catch(() => false);
  if (!ok) return { ok: false, message: "Your device didn't confirm the passkey. Try again." };
  await consumeSignupToken(deps.db, token, new Date());
  await notify(deps, user.phone, "Passkey added. Bigger payments now need it, and small ones can still use a texted code.");
  return { ok: true, message: "Done. The operator will ask for this passkey on bigger payments." };
}

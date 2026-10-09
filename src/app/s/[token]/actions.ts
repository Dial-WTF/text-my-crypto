"use server";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { notify } from "@/lib/bot/text";
import { botDeps } from "@/lib/deps";
import { checkSignupCode, consumeSignupToken, findUserByPhone, isClaimed, peekSignupToken } from "@/lib/identity";
import { finishRegistration, startRegistration } from "@/lib/passkeys";
import { rp } from "@/lib/web";
import type { ActionResult } from "@/ui/patterns/ApprovePanel/ApprovePanel";
import type { PasskeyBegin } from "@/ui/patterns/PasskeySetup/PasskeySetup";

const EXPIRED = "This link expired. Text “upgrade” to the operator for a new one.";

async function accountFor(token: string) {
  const { db } = botDeps();
  const phone = await peekSignupToken(db, token, new Date());
  const user = phone ? await findUserByPhone(db, phone) : null;
  return user && isClaimed(user) ? user : null;
}

/** Registration options, only for the code texted with the link: a link alone (forwarded, seen on a screen) can't add a passkey. */
export async function beginPasskeySetup(token: string, code: string): Promise<PasskeyBegin> {
  const user = await accountFor(token);
  if (!user?.handle) return { ok: false, message: EXPIRED };
  if (!(await checkSignupCode(botDeps().db, token, code, new Date()))) {
    return (await accountFor(token))
      ? { ok: false, message: "That code didn't match. It's in the same text as this link." }
      : { ok: false, message: EXPIRED };
  }
  const options: PublicKeyCredentialCreationOptionsJSON = await startRegistration(botDeps().db, rp(), token, { id: user.id, name: user.handle });
  return { ok: true, options };
}

export async function finishPasskeySetup(token: string, response: RegistrationResponseJSON): Promise<ActionResult> {
  const deps = botDeps();
  const user = await accountFor(token);
  if (!user) return { ok: false, message: EXPIRED };
  const ok = await finishRegistration(deps.db, rp(), token, user.id, response).catch(() => false);
  if (!ok) return { ok: false, message: "Your device didn't confirm the passkey. Try again." };
  await consumeSignupToken(deps.db, token, new Date());
  await notify(deps, user.phone, "Passkey added. Bigger payments now need it, and small ones can still use a texted code.");
  return { ok: true, message: "Done. The operator will ask for this passkey on bigger payments." };
}

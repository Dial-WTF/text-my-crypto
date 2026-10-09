"use server";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { approveIntent } from "@/lib/bot/settle";
import { MAX_CODE_ATTEMPTS } from "@/lib/codes";
import { botDeps } from "@/lib/deps";
import { getIntent, matchCode } from "@/lib/intents";
import { startApproval, verifyApproval } from "@/lib/passkeys";
import { rp } from "@/lib/web";
import type { ActionResult } from "@/ui/patterns/ApprovePanel/ApprovePanel";

const CLOSED: ActionResult = { ok: false, message: "This payment can't be approved any more." };

async function openIntent(intentId: string) {
  const intent = await getIntent(botDeps().db, intentId);
  return intent && intent.status === "pending" && intent.expiresAt > new Date() ? intent : null;
}

async function settle(intentId: string): Promise<ActionResult> {
  const r = await approveIntent(botDeps(), intentId);
  if (r.ok) return { ok: true, message: r.status === "escrowed" ? "Sent. It's waiting for them to claim." : "Sent." };
  if (r.reason === "not_claimable") return CLOSED;
  if (r.reason === "unconfirmed") return { ok: false, message: "Sent, but the network hasn't confirmed it yet. We'll text you when it does." };
  return { ok: false, message: "That payment didn't go through. No funds moved." };
}

export async function beginPasskeyApproval(intentId: string): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const intent = await openIntent(intentId);
  return intent ? startApproval(botDeps().db, rp(), intent) : null;
}

export async function finishPasskeyApproval(intentId: string, response: AuthenticationResponseJSON): Promise<ActionResult> {
  const intent = await openIntent(intentId);
  if (!intent) return CLOSED;
  const verified = await verifyApproval(botDeps().db, rp(), intent, response).catch(() => false);
  return verified ? settle(intentId) : { ok: false, message: "That passkey didn't match this account. Nothing was sent." };
}

export async function approveWithCode(intentId: string, code: string): Promise<ActionResult> {
  const intent = await openIntent(intentId);
  if (!intent || !intent.codeHash || intent.codeAttempts >= MAX_CODE_ATTEMPTS) return CLOSED;
  const [match] = await matchCode(botDeps().db, [intent], code.trim());
  return match ? settle(intentId) : { ok: false, message: "That code didn't match. Check the operator's last text." };
}

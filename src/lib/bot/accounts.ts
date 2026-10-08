import { type Chain, CHAINS } from "@/lib/chains";
import type { User, Wallet } from "@/lib/db/schema";
import {
  claimUser,
  createUser,
  displayName,
  findUserByHandle,
  findUserByPhone,
  getUserById,
  HANDLE_RE,
  isClaimed,
} from "@/lib/identity";
import { escrowedTo, issueSharedCode } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { addWallet, getWallet } from "@/lib/wallets";
import { notify } from "./text";
import type { BotDeps } from "./types";

export function enabledChains(deps: Pick<BotDeps, "adapters">): Array<[Chain, SettlementAdapter]> {
  return CHAINS.flatMap((c) => {
    const a = deps.adapters[c];
    return a ? [[c, a] as [Chain, SettlementAdapter]] : [];
  });
}

export async function ensureWallet(
  deps: Pick<BotDeps, "db" | "walletKey">,
  userId: string,
  chain: Chain,
  adapter: SettlementAdapter,
): Promise<Wallet> {
  const existing = await getWallet(deps.db, userId, chain);
  if (existing) return existing;
  const w = await adapter.createWallet();
  await addWallet(deps.db, { userId, chain, address: w.address, secret: w.secret, keyB64: deps.walletKey });
  const created = await getWallet(deps.db, userId, chain);
  if (!created) throw new Error("wallet creation failed");
  return created;
}

export type SignupResult = { ok: true; user: User; reply: string } | { ok: false; error: string };

/**
 * Turns a phone number into a named account: claims an unclaimed user (someone already sent them money)
 * or creates a new one, opens wallets on every enabled chain, drops test funds, and offers any waiting escrows.
 */
export async function completeSignup(deps: BotDeps, phone: string, rawName: string): Promise<SignupResult> {
  const handle = rawName.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return { ok: false, error: replies.badHandle() };
  const taken = await findUserByHandle(deps.db, handle);
  if (taken) return { ok: false, error: replies.handleTaken(handle) };

  const existing = await findUserByPhone(deps.db, phone);
  if (existing && isClaimed(existing)) return { ok: false, error: replies.handleTaken(existing.handle ?? handle) };
  const user = existing
    ? await claimUser(deps.db, existing.id, handle, deps.now())
    : await createUser(deps.db, { phone, handle }, deps.now());
  if (!user) return { ok: false, error: replies.handleTaken(handle) };

  let dripped = false;
  for (const [chain, adapter] of enabledChains(deps)) {
    const w = await ensureWallet(deps, user.id, chain, adapter);
    if (chain === "solana" && deps.dripAmount > 0n) {
      try {
        await adapter.fund(w.address, deps.dripAmount);
        dripped = true;
      } catch (e) {
        console.error("signup drip failed", e);
      }
    }
  }

  await offerEscrowClaims(deps, user);
  return { ok: true, user, reply: replies.joined(handle, dripped ? formatUsd(deps.dripAmount) : null) };
}

/** Texts the person one code that claims every escrow waiting for them. */
export async function offerEscrowClaims(deps: BotDeps, user: User): Promise<void> {
  const waiting = await escrowedTo(deps.db, user.id);
  if (waiting.length === 0) return;
  const code = await issueSharedCode(
    deps.db,
    waiting.map((i) => i.id),
  );
  const total = waiting.reduce((sum, i) => sum + i.amount, 0n);
  const senders = new Set<string>();
  for (const i of waiting) {
    const s = await getUserById(deps.db, i.senderId);
    if (s) senders.add(displayName(s));
  }
  await notify(deps, user.phone, replies.claimOffer(formatUsd(total), [...senders].join(", "), code));
}

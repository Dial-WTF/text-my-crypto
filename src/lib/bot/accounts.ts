import { errorText } from "@/lib/settlement/types";
import { type Chain, CHAINS } from "@/lib/chains";
import type { User, Wallet } from "@/lib/db/schema";
import {
  claimUser,
  createUser,
  displayName,
  findUserByPhone,
  getUserById,
  isClaimed,
  uniqueHandle,
} from "@/lib/identity";
import { escrowedTo, issueCode, issueSharedCode, pendingRequestsFor } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { cleanDisplayName, handleFromName } from "@/lib/names";
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

/** The sender's wallet on a chain; a wallet opened on first use gets the same test drip as signup. */
export async function ensureSenderWallet(
  deps: Pick<BotDeps, "db" | "walletKey" | "dripAmount">,
  userId: string,
  chain: Chain,
  adapter: SettlementAdapter,
): Promise<Wallet> {
  const existing = await getWallet(deps.db, userId, chain);
  if (existing) return existing;
  const wallet = await ensureWallet(deps, userId, chain, adapter);
  if (deps.dripAmount > 0n) {
    try {
      await adapter.fund(wallet.address, deps.dripAmount);
    } catch (e) {
      console.error("first-use drip failed", chain, errorText(e));
    }
  }
  return wallet;
}

export type SignupResult = { ok: true; user: User; reply: string } | { ok: false; error: string };

/**
 * Turns a phone number into a named account: claims an unclaimed user (someone already sent them money)
 * or creates a new one, opens wallets on every enabled chain and drops test funds. The caller sends the
 * welcome first, then `offerWaiting` for anything that was waiting on this number.
 */
export async function completeSignup(deps: BotDeps, phone: string, rawName: string): Promise<SignupResult> {
  const name = cleanDisplayName(rawName);
  if (!name) return { ok: false, error: replies.badName() };
  const handle = await uniqueHandle(deps.db, handleFromName(name) ?? `dial${phone.slice(-4)}`);

  const existing = await findUserByPhone(deps.db, phone);
  if (existing && isClaimed(existing)) return { ok: true, user: existing, reply: replies.whoami(displayName(existing), existing.handle ?? handle) };
  const user = existing
    ? await claimUser(deps.db, existing.id, handle, deps.now(), name)
    : await createUser(deps.db, { phone, handle, name }, deps.now());
  if (!user) return { ok: false, error: replies.badName() };

  let dripped = false;
  const solana = deps.adapters.solana;
  if (solana) {
    const w = await ensureWallet(deps, user.id, "solana", solana);
    if (deps.dripAmount > 0n) {
      try {
        await solana.fund(w.address, deps.dripAmount);
        dripped = true;
      } catch (e) {
        console.error("signup drip failed", errorText(e));
      }
    }
  }

  return { ok: true, user, reply: replies.joined(name, handle, dripped ? formatUsd(deps.dripAmount) : null) };
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

/** Someone asked a new person for money before they joined: show it again with a fresh code once they're in. */
export async function offerPendingRequests(deps: BotDeps, user: User): Promise<void> {
  for (const intent of await pendingRequestsFor(deps.db, user.id, deps.now())) {
    const requester = await getUserById(deps.db, intent.recipientId);
    if (!requester) continue;
    const code = await issueCode(deps.db, intent.id);
    const link = `${deps.appUrl}/a/${intent.id}`;
    const amount = formatUsd(intent.amount);
    const body =
      intent.kind === "invoice"
        ? replies.payInvoice(displayName(requester), amount, intent.note, code, link)
        : replies.payRequest(displayName(requester), amount, intent.note, code, link);
    await notify(deps, user.phone, body);
  }
}

/** After the welcome: escrows to claim and requests to pay that arrived before this person joined. */
export async function offerWaiting(deps: BotDeps, user: User): Promise<void> {
  await offerEscrowClaims(deps, user);
  await offerPendingRequests(deps, user);
}

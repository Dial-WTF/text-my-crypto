import { errorText } from "@/lib/settlement/types";
import { type Chain, CHAINS } from "@/lib/chains";
import type { Intent, User, Wallet } from "@/lib/db/schema";
import {
  claimUser,
  createUser,
  displayName,
  findUserByPhone,
  getUserById,
  isClaimed,
  uniqueHandle,
} from "@/lib/identity";
import { randomBase32 } from "@/lib/ids";
import { escrowedTo, issueCode, issueSharedCode, pendingRequestsFor } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { money } from "@/lib/settlement/amounts";
import { cleanDisplayName, handleFromName } from "@/lib/names";
import { replies } from "@/lib/operator/replies";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { SettlementUnknownError, TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { addWallet, claimDrip, getWallet, releaseDrip } from "@/lib/wallets";
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

/**
 * Sends a wallet its one test-funds drip. True when it landed now; false when the wallet already had it.
 * A transfer that never went out gives the drip back and rethrows, so it is retried next time instead of lost.
 * One that went out but wasn't confirmed keeps the drip taken: it may still land, and must not be sent twice.
 */
export async function dripOnce(
  deps: Pick<BotDeps, "db" | "dripAmount" | "now">,
  wallet: Wallet,
  adapter: SettlementAdapter,
): Promise<boolean> {
  if (deps.dripAmount <= 0n) return false;
  if (!(await claimDrip(deps.db, wallet.userId, wallet.chain, deps.now()))) return false;
  try {
    await adapter.fund(wallet.address, deps.dripAmount);
    return true;
  } catch (e) {
    const mayHaveMoved = e instanceof TransferUnconfirmedError || e instanceof SettlementUnknownError;
    if (!mayHaveMoved) await releaseDrip(deps.db, wallet.userId, wallet.chain);
    throw e;
  }
}

/**
 * The sender's wallet on a chain; a wallet opened on first use gets the same test drip as signup.
 * `triedDrip` is true when that drip was attempted now, so the caller doesn't try it again this turn.
 */
export async function ensureSenderWallet(
  deps: Pick<BotDeps, "db" | "walletKey" | "dripAmount" | "now">,
  userId: string,
  chain: Chain,
  adapter: SettlementAdapter,
): Promise<{ wallet: Wallet; triedDrip: boolean }> {
  const existing = await getWallet(deps.db, userId, chain);
  if (existing) return { wallet: existing, triedDrip: false };
  const wallet = await ensureWallet(deps, userId, chain, adapter);
  try {
    await dripOnce(deps, wallet, adapter);
  } catch (e) {
    console.error("first-use drip failed", chain, errorText(e));
  }
  return { wallet, triedDrip: true };
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
  // Handles are public (pay links, the ledger), so the fallback must not carry any phone digits.
  const handle = await uniqueHandle(deps.db, handleFromName(name) ?? `dial${randomBase32(4)}`);

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
    try {
      dripped = await dripOnce(deps, w, solana);
    } catch (e) {
      console.error("signup drip failed", errorText(e));
    }
  }

  return { ok: true, user, reply: replies.joined(name, handle, dripped ? formatUsd(deps.dripAmount) : null) };
}

/** How much these escrows add up to and who sent them, for a claim text. */
async function claimSummary(deps: BotDeps, escrows: Intent[]): Promise<{ amount: string; from: string }> {
  const total = escrows.reduce((sum, i) => sum + i.amount, 0n);
  // One chain: say it the way that chain reads ("$5 (0.1 TAZ)" on Zcash). Mixed: plain dollars.
  const [only, ...others] = new Set(escrows.map((i) => i.chain));
  const senders = new Set<string>();
  for (const i of escrows) {
    const s = await getUserById(deps.db, i.senderId);
    if (s) senders.add(displayName(s));
  }
  const amount = only && others.length === 0 ? money(total, only, deps.network) : formatUsd(total);
  return { amount, from: [...senders].join(", ") || "someone" };
}

/** Texts the person one code that claims every escrow waiting for them. */
export async function offerEscrowClaims(deps: BotDeps, user: User): Promise<void> {
  const waiting = await escrowedTo(deps.db, user.id, deps.now());
  if (waiting.length === 0) return;
  const code = await issueSharedCode(
    deps.db,
    waiting.map((i) => i.id),
  );
  const { amount, from } = await claimSummary(deps, waiting);
  await notify(deps, user.phone, replies.claimOffer(amount, from, code));
}

/** A claim the chain refused or didn't answer: nothing moved, so a fresh code lets them try again. */
export async function retryEscrowClaims(deps: BotDeps, failed: Intent[]): Promise<string> {
  const code = await issueSharedCode(
    deps.db,
    failed.map((i) => i.id),
  );
  const { amount, from } = await claimSummary(deps, failed);
  return replies.claimFailed(amount, from, code);
}

/** A claim that came too late: the escrow expired and can only go back to its sender. */
export async function expiredClaimReply(deps: BotDeps, escrow: Intent): Promise<string> {
  const { amount, from } = await claimSummary(deps, [escrow]);
  return replies.claimExpired(amount, from);
}

/** Someone asked a new person for money before they joined: show it again with a fresh code once they're in. */
export async function offerPendingRequests(deps: BotDeps, user: User): Promise<void> {
  for (const intent of await pendingRequestsFor(deps.db, user.id, deps.now())) {
    const requester = await getUserById(deps.db, intent.recipientId);
    if (!requester) continue;
    const code = await issueCode(deps.db, intent.id);
    const link = `${deps.appUrl}/a/${intent.id}`;
    const amount = money(intent.amount, intent.chain, deps.network);
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

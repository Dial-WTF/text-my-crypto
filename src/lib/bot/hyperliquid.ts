import type { Chain } from "@/lib/chains";
import type { Intent, User } from "@/lib/db/schema";
import { describe, isClaimed } from "@/lib/identity";
import { createIntent, findPendingDuplicate, isCodeLocked } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import type { VenueCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { type Capabilities, chainWith } from "@/lib/settlement/capabilities";
import { coinSymbol, type Fetch, formatPrice, midPrice } from "@/lib/settlement/hypercore";
import { venueOf } from "@/lib/settlement/registry";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { getWallet } from "@/lib/wallets";
import { ensureWallet } from "./accounts";
import { announce, checkMoney, codeFor, insufficientReply, type Prepared, overDailyCap, resolveCounterparty } from "./money";
import type { BotDeps } from "./types";

// "Send to Hyperliquid" by text and MCP: USDC from the chain's wallet into its trading venue (HyperEVM to
// HyperCore). Written against the adapter's `venue` module (capabilities.ts), never against a chain name.

const fail = (code: Extract<Prepared, { ok: false }>["error"]["code"], message: string): Prepared => ({
  ok: false,
  error: { code, message },
});

type Venue = { chain: Chain; adapter: SettlementAdapter; venue: NonNullable<Capabilities["venue"]> };

/** The enabled chain carrying a trading venue, or why there's none. */
function findVenue(deps: BotDeps): { ok: true; found: Venue } | { ok: false; message: string } {
  const found = chainWith(deps.adapters, "venue");
  return found
    ? { ok: true, found: { chain: found.chain, adapter: found.adapter, venue: found.module } }
    : { ok: false, message: replies.hyperCoreOff() };
}

/** Who gets the deposit: the sender (no counterparty) or a Dial user who has signed up. */
export async function venueRecipient(
  deps: BotDeps,
  user: User,
  counterparty: string | undefined,
): Promise<{ ok: true; user: User } | { ok: false; code: "unknown_handle" | "unknown_recipient" | "self"; message: string }> {
  if (!counterparty) return { ok: true, user };
  const resolved = await resolveCounterparty(deps, user, counterparty);
  if ("error" in resolved) return { ok: false, code: "unknown_handle", message: resolved.error };
  if (!("user" in resolved)) return { ok: false, code: "unknown_recipient", message: replies.hyperCoreWho(counterparty) };
  const other = resolved.user;
  if (other.id === user.id) return { ok: false, code: "self", message: replies.selfSend() };
  // Their venue account is their Dial wallet address on the chain, which only exists once they sign up.
  if (!isClaimed(other)) return { ok: false, code: "unknown_recipient", message: replies.hyperCoreNotOnDial(describe(other)) };
  return { ok: true, user: other };
}

/** The same deposit already waiting for approval. */
export async function pendingVenueDuplicate(deps: BotDeps, user: User, other: User, amount: bigint): Promise<Intent | null> {
  const found = chainWith(deps.adapters, "venue");
  if (!found) return null;
  return findPendingDuplicate(
    deps.db,
    { senderId: user.id, recipientId: other.id, kind: "venue", amount, chain: found.chain },
    deps.now(),
  );
}

/**
 * Validates a venue deposit to a resolved recipient and creates its PaymentIntent and code. The recipient's
 * venue account is their Dial wallet address on the chain. Same caps and approval as a send. Texts nobody.
 */
export async function createVenueIntent(deps: BotDeps, user: User, amountUsd: string, other: User): Promise<Prepared> {
  const on = findVenue(deps);
  if (!on.ok) return fail("chain_unavailable", on.message);
  const { chain, adapter } = on.found;
  const checked = checkMoney(deps, user, { amountUsd, chain });
  if (!checked.ok) return checked;
  const { amount } = checked;

  const mine = await ensureWallet(deps, user.id, chain, adapter);
  const balance = await adapter.getBalance(mine.address);
  if (balance < amount) return fail("insufficient", insufficientReply(deps, user, chain, balance));
  if (await overDailyCap(deps, user, amount)) return fail("over_daily", replies.overDaily(formatUsd(deps.perDayCap)));

  const recipientAddress = other.id === user.id ? mine.address : (await ensureWallet(deps, other.id, chain, adapter)).address;
  const intent = await createIntent(
    deps.db,
    {
      kind: "venue",
      createdBy: user.id,
      senderId: user.id,
      recipientId: other.id,
      chain,
      token: adapter.tokenId,
      recipientAddress,
      amount,
      note: null,
    },
    deps.now(),
  );
  const code = await codeFor(deps, user.id, intent.id, amount);
  return { ok: true, prepared: { intent, counterparty: other, code, approveUrl: `${deps.appUrl}/a/${intent.id}` } };
}

/** SMS path for "move $5 to hyperliquid" and "send @alex $5 to hyperliquid". Returns the reply. */
export async function prepareVenue(deps: BotDeps, user: User, cmd: VenueCommand): Promise<string> {
  const on = findVenue(deps);
  if (!on.ok) return on.message;
  const to = await venueRecipient(deps, user, cmd.counterparty);
  if (!to.ok) return to.message;
  const checked = checkMoney(deps, user, { amountUsd: cmd.amountUsd, chain: on.found.chain });
  if (!checked.ok) return checked.error.message;

  // Asked twice: the same confirmation again, with a fresh code, instead of a second deposit.
  const pending = await pendingVenueDuplicate(deps, user, to.user, checked.amount);
  if (pending) {
    if (isCodeLocked(pending)) return replies.codeMismatch(0);
    const code = await codeFor(deps, user.id, pending.id, pending.amount, { keepAttempts: true });
    const who = pending.recipientId === user.id ? null : describe(to.user);
    return replies.confirmHyperCore(formatUsd(pending.amount), who, code, `${deps.appUrl}/a/${pending.id}`);
  }

  const r = await createVenueIntent(deps, user, cmd.amountUsd, to.user);
  return r.ok ? announce(deps, user, r.prepared) : r.error.message;
}

/** The user's stablecoin balance on the venue (their wallet address there). Null: no venue, or no wallet on its chain yet. */
export async function venueBalance(
  deps: BotDeps,
  user: User,
): Promise<{ amount: bigint; network: string; address: string } | null> {
  const found = chainWith(deps.adapters, "venue");
  if (!found) return null;
  const wallet = await getWallet(deps.db, user.id, found.chain);
  if (!wallet) return null;
  const network = venueOf(found.chain, deps.network)?.network ?? found.module.name;
  return { amount: await found.module.balance(wallet.address), network, address: wallet.address };
}

/** "hl balance". */
export async function venueBalanceReply(deps: BotDeps, user: User): Promise<string> {
  if (!chainWith(deps.adapters, "venue")) return replies.hyperCoreOff();
  const b = await venueBalance(deps, user);
  return b ? replies.hlBalance(formatUsd(b.amount), b.network) : replies.hlNoAccount();
}

/** "price BTC": the Hyperliquid mid, a quote only. Needs no chain switched on. */
export async function priceReply(coin: string, fetchFn: Fetch = fetch): Promise<string> {
  const symbol = coinSymbol(coin);
  const mid = await midPrice(symbol, fetchFn);
  return mid ? replies.price(symbol, formatPrice(mid)) : replies.priceUnknown(symbol);
}

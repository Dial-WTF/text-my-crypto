import type { Intent, User } from "@/lib/db/schema";
import { describe, isClaimed } from "@/lib/identity";
import { createIntent, findPendingDuplicate, isCodeLocked } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import type { HyperCoreCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { coinSymbol, type Fetch, formatPrice, hyperCoreFor, midPrice, spotUsdc } from "@/lib/settlement/hypercore";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { getWallet } from "@/lib/wallets";
import { ensureWallet } from "./accounts";
import { announce, checkMoney, codeFor, insufficientReply, type Prepared, overDailyCap, resolveCounterparty } from "./money";
import type { BotDeps } from "./types";

const fail = (code: Extract<Prepared, { ok: false }>["error"]["code"], message: string): Prepared => ({
  ok: false,
  error: { code, message },
});

/** HyperEVM with HyperCore deposits switched on, or why not. */
function hyperCoreAdapter(deps: BotDeps): { ok: true; adapter: SettlementAdapter } | { ok: false; message: string } {
  const adapter = deps.adapters.hyperevm;
  return adapter?.hyperCore ? { ok: true, adapter } : { ok: false, message: replies.hyperCoreOff() };
}

/** Who gets the deposit: the sender (no counterparty) or a Dial user who has signed up. */
export async function hyperCoreRecipient(
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
  // Their HyperCore account is their Dial HyperEVM address, which only exists once they sign up.
  if (!isClaimed(other)) return { ok: false, code: "unknown_recipient", message: replies.hyperCoreNotOnDial(describe(other)) };
  return { ok: true, user: other };
}

/** The same deposit already waiting for approval. */
export function pendingHyperCoreDuplicate(deps: BotDeps, user: User, other: User, amount: bigint): Promise<Intent | null> {
  return findPendingDuplicate(
    deps.db,
    { senderId: user.id, recipientId: other.id, kind: "hypercore", amount, chain: "hyperevm" },
    deps.now(),
  );
}

/**
 * Validates a HyperCore deposit to a resolved recipient and creates its PaymentIntent and code. The recipient's
 * HyperCore account is their Dial HyperEVM address. Same caps and approval as a send. Texts nobody.
 */
export async function createHyperCoreIntent(deps: BotDeps, user: User, amountUsd: string, other: User): Promise<Prepared> {
  const on = hyperCoreAdapter(deps);
  if (!on.ok) return fail("chain_unavailable", on.message);
  const { adapter } = on;
  const checked = checkMoney(deps, user, { amountUsd, chain: "hyperevm" });
  if (!checked.ok) return checked;
  const { amount } = checked;

  const mine = await ensureWallet(deps, user.id, "hyperevm", adapter);
  const balance = await adapter.getBalance(mine.address);
  if (balance < amount) return fail("insufficient", insufficientReply(deps, user, "hyperevm", balance));
  if (await overDailyCap(deps, user, amount)) return fail("over_daily", replies.overDaily(formatUsd(deps.perDayCap)));

  const recipientAddress = other.id === user.id ? mine.address : (await ensureWallet(deps, other.id, "hyperevm", adapter)).address;
  const intent = await createIntent(
    deps.db,
    {
      kind: "hypercore",
      createdBy: user.id,
      senderId: user.id,
      recipientId: other.id,
      chain: "hyperevm",
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
export async function prepareHyperCore(deps: BotDeps, user: User, cmd: HyperCoreCommand): Promise<string> {
  const on = hyperCoreAdapter(deps);
  if (!on.ok) return on.message;
  const to = await hyperCoreRecipient(deps, user, cmd.counterparty);
  if (!to.ok) return to.message;
  const checked = checkMoney(deps, user, { amountUsd: cmd.amountUsd, chain: "hyperevm" });
  if (!checked.ok) return checked.error.message;

  // Asked twice: the same confirmation again, with a fresh code, instead of a second deposit.
  const pending = await pendingHyperCoreDuplicate(deps, user, to.user, checked.amount);
  if (pending) {
    if (isCodeLocked(pending)) return replies.codeMismatch(0);
    const code = await codeFor(deps, user.id, pending.id, pending.amount, { keepAttempts: true });
    const who = pending.recipientId === user.id ? null : describe(to.user);
    return replies.confirmHyperCore(formatUsd(pending.amount), who, code, `${deps.appUrl}/a/${pending.id}`);
  }

  const r = await createHyperCoreIntent(deps, user, cmd.amountUsd, to.user);
  return r.ok ? announce(deps, user, r.prepared) : r.error.message;
}

/** USDC in the user's HyperCore spot balance (their HyperEVM address), read from Hyperliquid's info API. Null: no account here yet. */
export async function hyperCoreBalance(
  deps: Pick<BotDeps, "db" | "network">,
  user: User,
  fetchFn: Fetch = fetch,
): Promise<{ amount: bigint; network: string; address: string } | null> {
  const core = hyperCoreFor(deps.network);
  const wallet = await getWallet(deps.db, user.id, "hyperevm");
  if (!core || !wallet) return null;
  return { amount: await spotUsdc(core.infoUrl, wallet.address, fetchFn), network: core.network, address: wallet.address };
}

/** "hl balance". */
export async function hlBalanceReply(deps: BotDeps, user: User): Promise<string> {
  const b = await hyperCoreBalance(deps, user);
  return b ? replies.hlBalance(formatUsd(b.amount), b.network) : replies.hlNoAccount();
}

/** "price BTC": the Hyperliquid mid, a quote only. */
export async function priceReply(coin: string, fetchFn: Fetch = fetch): Promise<string> {
  const symbol = coinSymbol(coin);
  const mid = await midPrice(symbol, fetchFn);
  return mid ? replies.price(symbol, formatPrice(mid)) : replies.priceUnknown(symbol);
}

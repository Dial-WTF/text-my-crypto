import { z } from "zod";
import { type Chain, CHAINS, chainLabel } from "@/lib/chains";
import { findContact } from "@/lib/contacts";
import { setConversation } from "@/lib/conversations";
import type { Intent, User } from "@/lib/db/schema";
import {
  createUnclaimedUser,
  describe,
  displayName,
  findUserByHandle,
  findUserByPhone,
  isClaimed,
  searchDirectory,
} from "@/lib/identity";
import {
  createIntent,
  findPendingDuplicate,
  findRecentCompletedDuplicate,
  issueCode,
  newIntentId,
  sentSince,
} from "@/lib/intents";
import { formatUsd, isUsdAmount, usdToBaseUnits } from "@/lib/money";
import type { MoneyCommand, WithdrawCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { hasOutboundSince } from "@/lib/sms/log";
import { hasPasskey } from "@/lib/passkeys";
import { normalizePhone } from "@/lib/phone";
import { seal } from "@/lib/secretbox";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { dripOnce, ensureSenderWallet, ensureWallet } from "./accounts";
import { notify, text } from "./text";
import type { BotDeps } from "./types";

export const moneyCommandSchema = z.object({
  kind: z.enum(["send", "request", "invoice"]),
  counterparty: z.string(),
  amountUsd: z.string(),
  note: z.string().optional(),
  chain: z.enum(CHAINS).optional(),
});

/** Why a payment wasn't created. `message` is the plain-English reply the operator texts. */
export type MoneyError = {
  code:
    | "chain_unavailable"
    | "bad_amount"
    | "over_cap"
    | "over_daily"
    | "insufficient"
    | "unknown_handle"
    | "unknown_recipient"
    | "self"
    | "bad_address"
    | "nothing_to_withdraw"
    | "duplicate";
  message: string;
};

/** A freshly created PaymentIntent plus what the operator needs to text about it. */
export type PreparedIntent = {
  intent: Intent;
  /** The other person (payer for requests/invoices, payee for sends); the user themself for withdrawals. */
  counterparty: User;
  /** The one-time code for the payer, or null when their passkey is required. */
  code: string | null;
  approveUrl: string;
};

export type Prepared = { ok: true; prepared: PreparedIntent } | { ok: false; error: MoneyError };

const fail = (code: MoneyError["code"], message: string): Prepared => ({ ok: false, error: { code, message } });

export type Resolved = { user: User } | { askFor: string } | { choose: User[] } | { error: string };

/**
 * Who does the sender mean? Like an operator: @handle and numbers connect directly (a new number gets an
 * unclaimed account); then the sender's own contacts; then the directory. One directory match connects
 * (the confirmation names them), several ask the sender to pick, none asks for a number.
 */
export async function resolveCounterparty(deps: BotDeps, owner: User, raw: string): Promise<Resolved> {
  if (raw.startsWith("@")) {
    const u = await findUserByHandle(deps.db, raw.slice(1).toLowerCase());
    return u ? { user: u } : { error: replies.unknownHandle(raw) };
  }
  const phone = normalizePhone(raw) ?? (await findContact(deps.db, owner.id, raw))?.phone ?? null;
  if (phone === deps.operatorNumber) return { error: replies.thatsMyNumber() };
  if (phone) return { user: (await findUserByPhone(deps.db, phone)) ?? (await createUnclaimedUser(deps.db, phone)) };

  const exact = await findUserByHandle(deps.db, raw);
  if (exact && exact.id !== owner.id) return { user: exact };
  const matches = (await searchDirectory(deps.db, raw, 6)).filter((u) => u.id !== owner.id).slice(0, 5);
  const [only] = matches;
  if (matches.length === 1 && only) return { user: only };
  if (matches.length > 1) return { choose: matches };
  return { askFor: raw };
}

/** Over the threshold, an account with a passkey must use it: no SMS code is issued. */
/** A fresh code for the payer, or null when this payment needs their passkey instead. */
export async function codeFor(deps: BotDeps, payerId: string, intentId: string, amount: bigint): Promise<string | null> {
  if (amount > deps.passkeyThreshold && (await hasPasskey(deps.db, payerId))) return null;
  return issueCode(deps.db, intentId);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

type Checked = { ok: true; chain: Chain; adapter: SettlementAdapter; amount: bigint } | { ok: false; error: MoneyError };

/** The checks that need no lookup: chain switched on, amount well-formed and under the per-payment cap. */
export function checkMoney(deps: BotDeps, user: User, cmd: Pick<MoneyCommand, "amountUsd" | "chain">): Checked {
  const chain = cmd.chain ?? user.defaultChain;
  const adapter = deps.adapters[chain];
  if (!adapter) return { ok: false, error: { code: "chain_unavailable", message: replies.chainUnavailable(chainLabel(chain)) } };
  const amount = isUsdAmount(cmd.amountUsd) ? usdToBaseUnits(cmd.amountUsd) : 0n;
  if (amount <= 0n) return { ok: false, error: { code: "bad_amount", message: replies.badAmount(formatUsd(deps.perTxCap)) } };
  if (amount > deps.perTxCap) return { ok: false, error: { code: "over_cap", message: replies.overCap(formatUsd(deps.perTxCap)) } };
  return { ok: true, chain, adapter, amount };
}

async function overDailyCap(deps: BotDeps, user: User, amount: bigint): Promise<boolean> {
  const today = await sentSince(deps.db, user.id, startOfUtcDay(deps.now()));
  return today + amount > deps.perDayCap;
}

const JUST_SENT_MS = 3 * 60_000;

export type Duplicate = { pending: Intent } | { justSent: Intent } | null;

/** The same payment is already waiting for approval, or (for a send) went out moments ago. */
export async function findDuplicate(
  deps: BotDeps,
  user: User,
  other: User,
  kind: MoneyCommand["kind"],
  amount: bigint,
  chain: Chain,
): Promise<Duplicate> {
  const isSend = kind === "send";
  const pending = await findPendingDuplicate(
    deps.db,
    { senderId: isSend ? user.id : other.id, recipientId: isSend ? other.id : user.id, kind, amount, chain },
    deps.now(),
  );
  if (pending) return { pending };
  if (!isSend) return null;
  const since = new Date(deps.now().getTime() - JUST_SENT_MS);
  const done = await findRecentCompletedDuplicate(deps.db, { senderId: user.id, recipientId: other.id, amount, chain }, since);
  return done ? { justSent: done } : null;
}

/**
 * SMS answer to a repeat. A pending payment gets a fresh code (as a normal confirmation if its first confirmation
 * never went out, otherwise as "you already asked… or NEW"); a just-sent one is pointed out. `askNew` means the
 * operator should wait for NEW.
 */
async function repeatReply(
  deps: BotDeps,
  user: User,
  other: User,
  kind: MoneyCommand["kind"],
  dup: Duplicate,
): Promise<{ text: string; askNew: boolean } | null> {
  if (!dup) return null;
  const otherName = describe(other);
  if ("justSent" in dup) return { text: replies.justSent(formatUsd(dup.justSent.amount), otherName), askNew: true };
  const { pending } = dup;
  if (kind !== "send") return { text: replies.alreadyRequested(formatUsd(pending.amount), otherName), askNew: false };
  const code = await codeFor(deps, user.id, pending.id, pending.amount);
  const link = `${deps.appUrl}/a/${pending.id}`;
  // Nothing texted since the payment was created: the first confirmation never went out (a retried turn),
  // so confirm normally. Otherwise they saw it and are repeating on purpose.
  if (!(await hasOutboundSince(deps.db, user.phone, pending.createdAt))) {
    const text = replies.confirmSend(formatUsd(pending.amount), otherName, chainLabel(pending.chain), pending.note, code, link);
    return { text, askNew: false };
  }
  return { text: replies.alreadyPending(formatUsd(pending.amount), otherName, code, link), askNew: true };
}

/**
 * Validates a send/request/invoice with a resolved counterparty and creates its PaymentIntent and code.
 * Texts nobody: callers decide who hears about it (see `announce`).
 */
export async function createMoneyIntent(deps: BotDeps, user: User, cmd: MoneyCommand, other: User): Promise<Prepared> {
  const checked = checkMoney(deps, user, cmd);
  if (!checked.ok) return checked;
  const { chain, adapter, amount } = checked;
  if (other.id === user.id) return fail("self", replies.selfSend());

  const mine =
    cmd.kind === "send" ? await ensureSenderWallet(deps, user.id, chain, adapter) : await ensureWallet(deps, user.id, chain, adapter);
  const note = cmd.note ?? null;

  if (cmd.kind === "send") {
    let balance = await adapter.getBalance(mine.address);
    // Short, and the test drip never landed (say the chain was down at signup): drop it now.
    if (balance < amount && (await dripOnce(deps, mine, adapter))) {
      balance += deps.dripAmount;
      await notify(deps, user.phone, replies.dripped(formatUsd(deps.dripAmount)));
    }
    if (balance < amount) return fail("insufficient", replies.insufficient(formatUsd(balance)));
    if (await overDailyCap(deps, user, amount)) return fail("over_daily", replies.overDaily(formatUsd(deps.perDayCap)));

    const id = newIntentId();
    let recipientAddress: string;
    let escrowSecretEnc: string | null = null;
    let escrowProgram: string | null = null;
    if (isClaimed(other)) {
      recipientAddress = (await ensureWallet(deps, other.id, chain, adapter)).address;
    } else if (adapter.escrow) {
      // Not on Dial yet: the money will wait in the escrow program's vault for this intent.
      recipientAddress = await adapter.escrow.vaultAddress(id);
      escrowProgram = adapter.escrow.programId;
    } else {
      const escrow = await adapter.createWallet();
      recipientAddress = escrow.address;
      escrowSecretEnc = await seal(escrow.secret, deps.walletKey);
    }
    const intent = await createIntent(
      deps.db,
      {
        id,
        kind: "send",
        createdBy: user.id,
        senderId: user.id,
        recipientId: other.id,
        chain,
        token: adapter.tokenId,
        recipientAddress,
        amount,
        note,
        escrowSecretEnc,
        escrowProgram,
      },
      deps.now(),
    );
    const code = await codeFor(deps, user.id, intent.id, amount);
    return { ok: true, prepared: { intent, counterparty: other, code, approveUrl: `${deps.appUrl}/a/${intent.id}` } };
  }

  const intent = await createIntent(
    deps.db,
    {
      kind: cmd.kind,
      createdBy: user.id,
      senderId: other.id,
      recipientId: user.id,
      chain,
      token: adapter.tokenId,
      recipientAddress: mine.address,
      amount,
      note,
    },
    deps.now(),
  );
  const code = await codeFor(deps, other.id, intent.id, amount);
  return { ok: true, prepared: { intent, counterparty: other, code, approveUrl: `${deps.appUrl}/a/${intent.id}` } };
}

function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** Moves funds out to an address the user controls. Same code/limit rules as a send. Texts nobody. */
export async function createWithdrawIntent(deps: BotDeps, user: User, cmd: WithdrawCommand): Promise<Prepared> {
  const chain = cmd.chain ?? user.defaultChain;
  const adapter = deps.adapters[chain];
  if (!adapter) return fail("chain_unavailable", replies.chainUnavailable(chainLabel(chain)));
  if (!adapter.isValidAddress(cmd.address)) return fail("bad_address", replies.badAddress(chainLabel(chain)));

  const mine = await ensureWallet(deps, user.id, chain, adapter);
  const balance = await adapter.getBalance(mine.address);
  const amount = cmd.amountUsd === "all" ? balance : isUsdAmount(cmd.amountUsd) ? usdToBaseUnits(cmd.amountUsd) : 0n;
  if (amount <= 0n) return fail("nothing_to_withdraw", replies.nothingToWithdraw());
  if (amount > deps.perTxCap) return fail("over_cap", replies.overCap(formatUsd(deps.perTxCap)));
  if (balance < amount) return fail("insufficient", replies.insufficient(formatUsd(balance)));
  if (await overDailyCap(deps, user, amount)) return fail("over_daily", replies.overDaily(formatUsd(deps.perDayCap)));

  const intent = await createIntent(
    deps.db,
    {
      kind: "withdraw",
      createdBy: user.id,
      senderId: user.id,
      recipientId: user.id,
      chain,
      token: adapter.tokenId,
      recipientAddress: cmd.address,
      amount,
      note: null,
    },
    deps.now(),
  );
  const code = await codeFor(deps, user.id, intent.id, amount);
  return { ok: true, prepared: { intent, counterparty: user, code, approveUrl: `${deps.appUrl}/a/${intent.id}` } };
}

/**
 * Texts the payer of a request or invoice, and returns the message for the person who started it:
 * the approval prompt for sends and withdrawals, a confirmation for requests and invoices.
 */
export async function announce(deps: BotDeps, user: User, p: PreparedIntent): Promise<string> {
  const { intent, code, approveUrl: link } = p;
  const amount = formatUsd(intent.amount);
  const chain = chainLabel(intent.chain);
  const other = describe(p.counterparty);
  switch (intent.kind) {
    case "send":
      return replies.confirmSend(amount, other, chain, intent.note, code, link);
    case "withdraw":
      return replies.confirmWithdraw(amount, shortAddress(intent.recipientAddress), chain, code, link);
    case "request":
      await text(deps, p.counterparty.phone, replies.payRequest(displayName(user), amount, intent.note, code, link));
      return replies.requestSent(amount, other);
    case "invoice":
      await text(deps, p.counterparty.phone, replies.payInvoice(displayName(user), amount, intent.note, code, link));
      return replies.invoiceSent(amount, other, link);
  }
}

/**
 * SMS path for send/request/invoice. Returns the reply for the person who texted.
 * A repeat of something already waiting (or just sent) is answered conversationally instead of creating a
 * second payment; `allowDuplicate` is set once the person has confirmed with NEW.
 */
export async function prepareMoney(
  deps: BotDeps,
  user: User,
  cmd: MoneyCommand,
  opts: { allowDuplicate?: boolean } = {},
): Promise<string> {
  const checked = checkMoney(deps, user, cmd);
  if (!checked.ok) return checked.error.message;

  const resolved = await resolveCounterparty(deps, user, cmd.counterparty);
  if ("error" in resolved) return resolved.error;
  if ("choose" in resolved) {
    await setConversation(
      deps.db,
      user.phone,
      {
        state: "awaiting_choice",
        payload: {
          name: cmd.counterparty,
          command: JSON.stringify(cmd),
          handles: resolved.choose.flatMap((u) => (u.handle ? [u.handle] : [])),
        },
      },
      deps.now(),
    );
    return replies.chooseRecipient(cmd.counterparty, resolved.choose.map(describe));
  }
  if ("askFor" in resolved) {
    await setConversation(
      deps.db,
      user.phone,
      { state: "awaiting_number", payload: { name: resolved.askFor, command: JSON.stringify(cmd) } },
      deps.now(),
    );
    return replies.askNumber(resolved.askFor);
  }

  const other = resolved.user;
  if (other.id === user.id) return replies.selfSend();

  if (!opts.allowDuplicate) {
    const dup = await findDuplicate(deps, user, other, cmd.kind, checked.amount, checked.chain);
    const repeat = await repeatReply(deps, user, other, cmd.kind, dup);
    if (repeat?.askNew) {
      await setConversation(deps.db, user.phone, { state: "awaiting_duplicate", payload: { command: JSON.stringify(cmd) } }, deps.now());
    }
    if (repeat) return repeat.text;
  }

  const r = await createMoneyIntent(deps, user, cmd, other);
  return r.ok ? announce(deps, user, r.prepared) : r.error.message;
}

/** SMS path for withdrawals. Returns the reply for the person who texted. */
export async function prepareWithdraw(deps: BotDeps, user: User, cmd: WithdrawCommand): Promise<string> {
  const r = await createWithdrawIntent(deps, user, cmd);
  return r.ok ? announce(deps, user, r.prepared) : r.error.message;
}

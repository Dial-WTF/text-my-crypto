import { z } from "zod";
import { type Chain, CHAINS, chainLabel } from "@/lib/chains";
import { findContact } from "@/lib/contacts";
import { setConversation } from "@/lib/conversations";
import { isEvmName, normalizeName, wrongNetworkBasename } from "@/lib/evm-names";
import type { Intent, User, Wallet } from "@/lib/db/schema";
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
  isCodeLocked,
  type IssueOptions,
  issueCode,
  newIntentId,
  sentSince,
} from "@/lib/intents";
import { formatUsd, isUsdAmount, usdToBaseUnits } from "@/lib/money";
import { money } from "@/lib/settlement/amounts";
import type { MoneyCommand, WithdrawCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { hasOutboundSince } from "@/lib/sms/log";
import { hasPasskey } from "@/lib/passkeys";
import { withdrawTarget } from "@/lib/payment-labels";
import { normalizePhone } from "@/lib/phone";
import { seal } from "@/lib/secretbox";
import { type NameService, nameServiceFor } from "@/lib/settlement/capabilities";
import { REGISTRY } from "@/lib/settlement/registry";
import { errorText, type SettlementAdapter } from "@/lib/settlement/types";
import { getWallet } from "@/lib/wallets";
import { dripOnce, enabledChains, ensureSenderWallet, ensureWallet } from "./accounts";
import { notify, text } from "./text";
import type { BotDeps } from "./types";

export const moneyCommandSchema = z.object({
  kind: z.enum(["send", "request", "invoice"]),
  counterparty: z.string(),
  amountUsd: z.string(),
  note: z.string().optional(),
  chain: z.enum(CHAINS).optional(),
});

export const withdrawCommandSchema = z.object({
  kind: z.literal("withdraw"),
  amountUsd: z.string(),
  address: z.string(),
  chain: z.enum(CHAINS).optional(),
});

/** Testnets where Circle's faucet hands out test USDC. Tempo and Robinhood use other test tokens. */
const CIRCLE_FAUCET_CHAINS: ReadonlySet<Chain> = new Set<Chain>(["solana", "base", "ethereum", "arbitrum", "hyperevm"]);
const CIRCLE_FAUCET = "faucet.circle.com";

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
    | "which_chain"
    | "venue_account_missing"
    | "unknown_name"
    | "name_lookup_failed"
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

/**
 * A fresh code for the payer, or null when this payment needs their passkey instead: over the threshold,
 * an account with a passkey must use it. Pass keepAttempts when re-sending a code for an existing payment.
 */
export async function codeFor(
  deps: BotDeps,
  payerId: string,
  intentId: string,
  amount: bigint,
  opts: IssueOptions = {},
): Promise<string | null> {
  if (amount > deps.passkeyThreshold && (await hasPasskey(deps.db, payerId))) return null;
  return issueCode(deps.db, intentId, opts);
}

/** dripOnce, but a failure is logged instead of ending the turn. */
export async function dripQuietly(deps: BotDeps, wallet: Wallet, adapter: SettlementAdapter): Promise<boolean> {
  try {
    return await dripOnce(deps, wallet, adapter);
  } catch (e) {
    console.error("short-send drip failed", wallet.chain, errorText(e));
    return false;
  }
}

/** Not enough money: where to add more (their pay page lists deposit options) and, on testnet, a faucet. */
export function insufficientReply(deps: BotDeps, user: User, chain: Chain, balance: bigint): string {
  const testnet = deps.network === "testnet";
  const payUrl = user.handle ? `${deps.appUrl}/@${user.handle}` : `${deps.appUrl}/wallet`;
  const faucet = testnet && CIRCLE_FAUCET_CHAINS.has(chain) ? CIRCLE_FAUCET : null;
  return replies.insufficient(money(balance, chain, deps.network), payUrl, testnet, faucet);
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

export async function overDailyCap(deps: BotDeps, user: User, amount: bigint): Promise<boolean> {
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
  if ("justSent" in dup) return { text: replies.justSent(money(dup.justSent.amount, dup.justSent.chain, deps.network), otherName), askNew: true };
  const { pending } = dup;
  if (kind !== "send") return { text: replies.alreadyRequested(money(pending.amount, pending.chain, deps.network), otherName), askNew: false };
  // Too many wrong codes on it already: repeating the command must not hand out a fresh one.
  if (isCodeLocked(pending)) return { text: replies.codeMismatch(0), askNew: false };
  const code = await codeFor(deps, user.id, pending.id, pending.amount, { keepAttempts: true });
  const link = `${deps.appUrl}/a/${pending.id}`;
  // Nothing texted since the payment was created: the first confirmation never went out (a retried turn),
  // so confirm normally. Otherwise they saw it and are repeating on purpose.
  if (!(await hasOutboundSince(deps.db, user.phone, pending.createdAt))) {
    const text = replies.confirmSend(money(pending.amount, pending.chain, deps.network), otherName, chainLabel(pending.chain), pending.note, code, link);
    return { text, askNew: false };
  }
  return { text: replies.alreadyPending(money(pending.amount, pending.chain, deps.network), otherName, code, link), askNew: true };
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

  const { wallet: mine, triedDrip } =
    cmd.kind === "send"
      ? await ensureSenderWallet(deps, user.id, chain, adapter)
      : { wallet: await ensureWallet(deps, user.id, chain, adapter), triedDrip: false };
  const note = cmd.note ?? null;

  if (cmd.kind === "send") {
    let balance = await adapter.getBalance(mine.address);
    // Zcash payments carry the recipient's next fees on top; other chains carry nothing.
    const fees = adapter.carriedFees?.(isClaimed(other) ? "dial" : adapter.escrow ? "outside" : "escrow") ?? 0n;
    // Short, and the test drip never landed (say the chain was down at signup): drop it now. A wallet opened
    // this turn already had its try. A drip that fails (empty treasury, rate limit) just means "not enough".
    if (balance < amount + fees && !triedDrip && (await dripQuietly(deps, mine, adapter))) {
      balance += deps.dripAmount;
      await notify(deps, user.phone, replies.dripped(money(deps.dripAmount, chain, deps.network)));
    }
    if (balance < amount) return fail("insufficient", insufficientReply(deps, user, chain, balance));
    if (balance < amount + fees) {
      return fail("insufficient", replies.feeShort(money(balance, chain, deps.network), money(fees, chain, deps.network), chainLabel(chain)));
    }
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

type ChainPick = { ok: true; chain: Chain; adapter: SettlementAdapter } | { ok: false; error: MoneyError };

/**
 * Which chain a withdrawal leaves from: the one they named; else their default chain if the address fits it;
 * else the only enabled chain the address fits (a 0x address on a Solana account). Several fit: ask which.
 */
function withdrawChain(deps: BotDeps, user: User, cmd: WithdrawCommand): ChainPick {
  const named = cmd.chain ?? user.defaultChain;
  const adapter = deps.adapters[named];
  if (adapter?.isValidAddress(cmd.address)) return { ok: true, chain: named, adapter };
  if (!cmd.chain) {
    const fits = enabledChains(deps).filter(([, a]) => a.isValidAddress(cmd.address));
    const [only] = fits;
    if (fits.length === 1 && only) return { ok: true, chain: only[0], adapter: only[1] };
    if (fits.length > 1) {
      const message = replies.whichChain(fits.map(([c]) => c).sort());
      return { ok: false, error: { code: "which_chain", message } };
    }
  }
  if (!adapter) return { ok: false, error: { code: "chain_unavailable", message: replies.chainUnavailable(chainLabel(named)) } };
  return { ok: false, error: { code: "bad_address", message: replies.badAddress(chainLabel(named)) } };
}

/** Nothing on this chain: say where the money is, if it's on another chain. */
async function nothingToWithdrawReply(deps: BotDeps, user: User, chain: Chain): Promise<string> {
  const elsewhere: Array<[Chain, bigint]> = [];
  for (const [other, adapter] of enabledChains(deps)) {
    if (other === chain) continue;
    const wallet = await getWallet(deps.db, user.id, other);
    if (!wallet) continue;
    // A chain that won't answer just isn't mentioned.
    const balance = await adapter.getBalance(wallet.address).catch(() => 0n);
    if (balance > 0n) elsewhere.push([other, balance]);
  }
  const lines = elsewhere.map(([c, b]) => `${formatUsd(b)} on ${chainLabel(c)}`);
  return replies.nothingToWithdraw(chainLabel(chain), lines, elsewhere[0]?.[0]);
}

type Destination = { ok: true; cmd: WithdrawCommand; name: string | null } | { ok: false; error: MoneyError };

/**
 * An ENS name or Basename becomes its address here, once: the intent stores that address, the confirmation
 * shows it next to the name, and settlement never looks the name up again. The chain whose name service
 * answers for the ending (Base for Basenames, Ethereum for other .eth names) is the chain, unless they named
 * one. A chain that's switched off still resolves first, so they hear "isn't switched on yet".
 */
async function resolveDestination(deps: BotDeps, cmd: WithdrawCommand): Promise<Destination> {
  if (!isEvmName(cmd.address)) return { ok: true, cmd, name: null };
  const name = normalizeName(cmd.address) ?? cmd.address.toLowerCase();
  // Enabled chains answer with their adapter's module; chains that are off with the one from deps.names.
  const service = nameServiceFor({ ...nameHolders(deps), ...deps.adapters }, name);
  let address: string | null = null;
  try {
    address = service ? await service.names.resolve(name) : null;
  } catch (e) {
    console.error("name lookup failed", name, errorText(e));
    return { ok: false, error: { code: "name_lookup_failed", message: replies.nameLookupDown(name) } };
  }
  if (service && address) return { ok: true, cmd: { ...cmd, address, chain: cmd.chain ?? service.chain }, name };
  const network = service ? (REGISTRY[service.chain][deps.network]?.network ?? chainLabel(service.chain)) : null;
  const testBasename = deps.network === "testnet" && wrongNetworkBasename(name, deps.network);
  const message = replies.unknownName(name, network, testBasename);
  return { ok: false, error: { code: "unknown_name", message } };
}

/** deps.names in the shape nameServiceFor reads. */
function nameHolders(deps: BotDeps): Partial<Record<Chain, { names: NameService }>> {
  const out: Partial<Record<Chain, { names: NameService }>> = {};
  for (const [chain, names] of Object.entries(deps.names ?? {}) as Array<[Chain, NameService]>) out[chain] = { names };
  return out;
}

/** Moves funds out to an address (or ENS name / Basename) the user controls. Same code/limit rules as a send. Texts nobody. */
export async function createWithdrawIntent(deps: BotDeps, user: User, asked: WithdrawCommand): Promise<Prepared> {
  const dest = await resolveDestination(deps, asked);
  if (!dest.ok) return dest;
  const { cmd } = dest;
  const picked = withdrawChain(deps, user, cmd);
  if (!picked.ok) return picked;
  const { chain, adapter } = picked;

  const mine = await ensureWallet(deps, user.id, chain, adapter);
  const balance = await adapter.getBalance(mine.address);
  const amount = cmd.amountUsd === "all" ? balance : isUsdAmount(cmd.amountUsd) ? usdToBaseUnits(cmd.amountUsd) : 0n;
  if (amount <= 0n) return fail("nothing_to_withdraw", await nothingToWithdrawReply(deps, user, chain));
  if (amount > deps.perTxCap) return fail("over_cap", replies.overCap(formatUsd(deps.perTxCap)));
  if (balance < amount) return fail("insufficient", insufficientReply(deps, user, chain, balance));
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
      recipientName: dest.name,
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
  const amount = money(intent.amount, intent.chain, deps.network);
  const chain = chainLabel(intent.chain);
  const other = describe(p.counterparty);
  switch (intent.kind) {
    case "send":
      return replies.confirmSend(amount, other, chain, intent.note, code, link);
    case "withdraw":
      return replies.confirmWithdraw(amount, withdrawTarget(intent), chain, code, link);
    case "venue":
      return replies.confirmHyperCore(amount, intent.recipientId === intent.senderId ? null : other, code, link);
    // Someone not on Dial can't use a code yet: they get one after they sign up (offerWaiting).
    case "request":
      await text(
        deps,
        p.counterparty.phone,
        isClaimed(p.counterparty)
          ? replies.payRequest(displayName(user), amount, intent.note, code, link)
          : replies.payRequestNewcomer(displayName(user), amount, intent.note),
      );
      return replies.requestSent(amount, other);
    case "invoice":
      await text(
        deps,
        p.counterparty.phone,
        isClaimed(p.counterparty)
          ? replies.payInvoice(displayName(user), amount, intent.note, code, link)
          : replies.payInvoiceNewcomer(displayName(user), amount, intent.note),
      );
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

/** SMS path for withdrawals. Returns the reply for the person who texted. Asking which chain waits for the answer. */
export async function prepareWithdraw(deps: BotDeps, user: User, cmd: WithdrawCommand): Promise<string> {
  const r = await createWithdrawIntent(deps, user, cmd);
  if (r.ok) return announce(deps, user, r.prepared);
  if (r.error.code === "which_chain") {
    await setConversation(deps.db, user.phone, { state: "awaiting_chain", payload: { command: JSON.stringify(cmd) } }, deps.now());
  }
  return r.error.message;
}

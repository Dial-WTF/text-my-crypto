import { type Chain, chainLabel } from "@/lib/chains";
import type { Intent, User } from "@/lib/db/schema";
import { describe, displayName, getUserById, isClaimed } from "@/lib/identity";
import {
  claimSplitForSettlement,
  createIntent,
  finishUnconfirmedTransfer,
  isCodeLocked,
  issueSharedCode,
  markEscrowed,
  markFailed,
  markSettled,
  markTransferUnconfirmed,
  newIntentId,
  newSplitId,
  splitLegs,
  unconfirmedTransferTx,
} from "@/lib/intents";
import { formatUsd, isUsdAmount, usdToBaseUnits } from "@/lib/money";
import type { SplitCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { shareList, splitReplies } from "@/lib/operator/split-replies";
import { hasPasskey } from "@/lib/passkeys";
import { seal } from "@/lib/secretbox";
import { type BatchTransfer, chainWith } from "@/lib/settlement/capabilities";
import { errorText, HeldBackError, type SettlementAdapter, type SettleResult, type TransferOutcome } from "@/lib/settlement/types";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { isOptedOut } from "@/lib/sms/optout";
import { getWallet, unsealWallet } from "@/lib/wallets";
import { ensureSenderWallet, ensureWallet } from "./accounts";
import { dripQuietly, insufficientReply, type MoneyError, overDailyCap, overDailyCapAtApproval, resolveCounterparty } from "./money";
import { receiptUrl, type SettleOutcome } from "./settle";
import { notify } from "./text";
import type { BotDeps } from "./types";

/** Most people in one split, the sender included when they take a share. */
export const MAX_SPLIT_PEOPLE = 10;
/** USDC base units in a cent (6 decimals). */
const CENT = 10_000n;
const DAY_MS = 86_400_000;

export type SplitErrorCode = MoneyError["code"] | "split_chain" | "split_people" | "ambiguous_recipient";
export type SplitError = { code: SplitErrorCode; message: string };

/** A split waiting for its one approval: a leg (an ordinary send intent) per person, sharing a split id and a code. */
export type PreparedSplit = {
  splitId: string;
  /** The chain carrying the batch. */
  chain: Chain;
  legs: Array<{ intent: Intent; person: User }>;
  /** What the sender keeps as their own share, when they're in the split. */
  mine: bigint | null;
  total: bigint;
  code: string | null;
  approveUrl: string;
};

export type SplitPrepared = { ok: true; split: PreparedSplit } | { ok: false; error: SplitError };

const fail = (code: SplitErrorCode, message: string): SplitPrepared => ({ ok: false, error: { code, message } });

/**
 * `total` divided `ways` ways, to the cent. Leftover cents go to the first share. Null when a share
 * would be under a cent. Amounts here are always whole cents (at most two decimals are accepted).
 */
export function splitShares(total: bigint, ways: number): bigint[] | null {
  if (ways < 1) return null;
  const cents = total / CENT;
  const each = cents / BigInt(ways);
  if (each <= 0n) return null;
  const rest = cents - each * BigInt(ways);
  return Array.from({ length: ways }, (_, i) => (each + (i === 0 ? rest : 0n)) * CENT);
}

/** "@alex" for people on Dial, a masked number for someone new. Short, for lists. */
function shortName(u: User): string {
  return u.handle ? `@${u.handle}` : describe(u);
}

function sharesText(legs: Array<{ amount: bigint; person: User }>): string {
  return shareList(legs.map((l) => ({ name: shortName(l.person), amount: formatUsd(l.amount) })));
}

/** Who each name in the split means. Anything that doesn't connect to exactly one person stops the split. */
export async function resolvePeople(
  deps: BotDeps,
  user: User,
  names: string[],
): Promise<{ ok: true; people: User[] } | { ok: false; error: SplitError }> {
  const people: User[] = [];
  for (const name of names) {
    const r = await resolveCounterparty(deps, user, name);
    if ("error" in r) return { ok: false, error: { code: "unknown_handle", message: r.error } };
    if ("askFor" in r) return { ok: false, error: { code: "unknown_recipient", message: splitReplies.unknown(r.askFor) } };
    if ("choose" in r) {
      return { ok: false, error: { code: "ambiguous_recipient", message: splitReplies.ambiguous(name, r.choose.map(shortName)) } };
    }
    people.push(r.user);
  }
  return { ok: true, people };
}

type SplitChain = { ok: true; chain: Chain; adapter: SettlementAdapter; batch: BatchTransfer } | { ok: false; error: SplitError };

/**
 * Where a split runs: a chain whose transactions batch (Tempo's atomic calls). A chain they named that can't
 * batch is refused with the one that can, never faked with one transfer after another. Named none: their
 * default chain if it batches, else the first that does.
 */
export function splitChain(deps: Pick<BotDeps, "adapters">, user: User, named: Chain | undefined): SplitChain {
  const found = chainWith(deps.adapters, "batch", named ?? user.defaultChain);
  if (!found) return { ok: false, error: { code: "chain_unavailable", message: splitReplies.unavailable() } };
  if (named && found.chain !== named) {
    return { ok: false, error: { code: "split_chain", message: splitReplies.needsBatch(chainLabel(named), chainLabel(found.chain), found.chain) } };
  }
  return { ok: true, chain: found.chain, adapter: found.adapter, batch: found.module };
}

/**
 * Validates a split with its people resolved and creates a leg per person, all approved by one code.
 * Splits run where one transaction carries every leg (see splitChain). Per-payment caps apply to each
 * leg, the daily cap and the balance check to what the sender pays in all. Texts nobody.
 */
export async function createSplit(deps: BotDeps, user: User, cmd: SplitCommand, people: User[]): Promise<SplitPrepared> {
  const picked = splitChain(deps, user, cmd.chain);
  if (!picked.ok) return picked;
  const { chain, adapter, batch } = picked;

  const ways = people.length + (cmd.includeMe ? 1 : 0);
  if (people.length === 0 || ways < 2) return fail("split_people", splitReplies.tooFew());
  if (ways > MAX_SPLIT_PEOPLE || people.length > batch.maxLegs) return fail("split_people", splitReplies.tooMany(MAX_SPLIT_PEOPLE));
  const seen = new Set<string>();
  for (const p of people) {
    if (p.id === user.id) return fail("self", replies.selfSend());
    if (seen.has(p.id)) return fail("split_people", splitReplies.twice(shortName(p)));
    seen.add(p.id);
  }

  const total = isUsdAmount(cmd.amountUsd) ? usdToBaseUnits(cmd.amountUsd) : 0n;
  if (total <= 0n) return fail("bad_amount", replies.badAmount(formatUsd(deps.perTxCap)));
  const shares = splitShares(total, ways);
  if (!shares) return fail("bad_amount", splitReplies.tooSmall(formatUsd(total), ways));
  // People listed come first, so the leftover cent goes to the first of them; the sender's share is last.
  const legAmounts = shares.slice(0, people.length);
  if (legAmounts.some((a) => a > deps.perTxCap)) return fail("over_cap", replies.overCap(formatUsd(deps.perTxCap)));
  const pays = legAmounts.reduce((a, b) => a + b, 0n);

  const { wallet: mine, triedDrip } = await ensureSenderWallet(deps, user.id, chain, adapter);
  let balance = await adapter.getBalance(mine.address);
  if (balance < pays && !triedDrip && (await dripQuietly(deps, mine, adapter))) {
    balance += deps.dripAmount;
    await notify(deps, user.phone, replies.dripped(formatUsd(deps.dripAmount)));
  }
  if (balance < pays) return fail("insufficient", insufficientReply(deps, user, chain, balance));
  if (await overDailyCap(deps, user, pays)) return fail("over_daily", replies.overDaily(formatUsd(deps.perDayCap)));

  const splitId = newSplitId();
  const legs: PreparedSplit["legs"] = [];
  for (const [i, person] of people.entries()) {
    const amount = legAmounts[i] ?? 0n;
    // Someone not on Dial yet: their share lands in a wallet held for them, inside the same transaction,
    // and waits there for them to claim it like any other payment to someone new.
    let recipientAddress: string;
    let escrowSecretEnc: string | null = null;
    if (isClaimed(person)) {
      recipientAddress = (await ensureWallet(deps, person.id, chain, adapter)).address;
    } else {
      const escrow = await adapter.createWallet();
      recipientAddress = escrow.address;
      escrowSecretEnc = await seal(escrow.secret, deps.walletKey);
    }
    const intent = await createIntent(
      deps.db,
      {
        id: newIntentId(),
        kind: "send",
        createdBy: user.id,
        senderId: user.id,
        recipientId: person.id,
        chain,
        token: adapter.tokenId,
        recipientAddress,
        amount,
        note: cmd.note ?? null,
        escrowSecretEnc,
        splitId,
      },
      deps.now(),
    );
    legs.push({ intent, person });
  }
  const code = await splitCode(deps, user.id, legs.map((l) => l.intent));
  const [first] = legs;
  return {
    ok: true,
    split: {
      splitId,
      chain,
      legs,
      mine: cmd.includeMe ? (shares.at(-1) ?? null) : null,
      total,
      code,
      approveUrl: `${deps.appUrl}/a/${first?.intent.id ?? ""}`,
    },
  };
}

/** One code for every leg, or null when the total needs the sender's passkey (as a single payment that size would). */
async function splitCode(deps: BotDeps, senderId: string, legs: Intent[], keepAttempts = false): Promise<string | null> {
  const pays = legs.reduce((a, l) => a + l.amount, 0n);
  if (pays > deps.passkeyThreshold && (await hasPasskey(deps.db, senderId))) return null;
  return issueSharedCode(
    deps.db,
    legs.map((l) => l.id),
    { keepAttempts },
  );
}

/** The confirmation the sender approves: everyone's share and the one code. */
export function confirmSplitText(p: PreparedSplit): string {
  const ways = p.legs.length + (p.mine === null ? 0 : 1);
  const shares = sharesText(p.legs.map((l) => ({ amount: l.intent.amount, person: l.person })));
  const note = p.legs[0]?.intent.note ?? null;
  const chain = chainLabel(p.chain);
  return splitReplies.confirm(formatUsd(p.total), ways, shares, p.mine === null ? null : formatUsd(p.mine), chain, note, p.code, p.approveUrl);
}

/** SMS path for "split $30 between …". Returns the reply for the person who texted. */
export async function prepareSplit(deps: BotDeps, user: User, cmd: SplitCommand): Promise<string> {
  // Chain and head count are checked before anyone is looked up, so a split that can't run never creates accounts.
  const picked = splitChain(deps, user, cmd.chain);
  if (!picked.ok) return picked.error.message;
  if (cmd.people.length + (cmd.includeMe ? 1 : 0) > MAX_SPLIT_PEOPLE) return splitReplies.tooMany(MAX_SPLIT_PEOPLE);
  const resolved = await resolvePeople(deps, user, cmd.people);
  if (!resolved.ok) return resolved.error.message;
  const r = await createSplit(deps, user, cmd, resolved.people);
  return r.ok ? confirmSplitText(r.split) : r.error.message;
}

/**
 * Settles an approved split: claims every leg at once, then pays them all in one transaction on the chain's batch module.
 * All or nothing: if the transaction doesn't land, every leg is marked failed and nothing moved. If it went out with
 * no answer, every leg waits on it (reconcileSplit). If it landed with some shares held back, only those failed.
 */
export async function approveSplit(deps: BotDeps, splitId: string): Promise<SettleOutcome> {
  const claimed = await claimSplitForSettlement(deps.db, splitId, deps.now());
  if (claimed.length === 0) return { ok: false, reason: "not_claimable" };
  const legs = await splitLegs(deps.db, splitId);
  const failAll = async (error: string) => {
    for (const leg of claimed) await markFailed(deps.db, leg.id, error);
    return { ok: false as const, reason: "failed" as const, error };
  };
  const [head] = legs;
  const sender = head ? await getUserById(deps.db, head.senderId) : null;
  // A leg cancelled or used on its own since: the split is no longer what was approved.
  if (!head || !sender || claimed.length !== legs.length) return failAll("Split changed before approval");
  const people = await Promise.all(legs.map((l) => getUserById(deps.db, l.recipientId)));
  if (people.some((p) => !p)) return failAll("Missing recipient");

  const pays = legs.reduce((a, l) => a + l.amount, 0n);
  if (await overDailyCapAtApproval(deps, head.senderId)) {
    await notify(deps, sender.phone, replies.overDaily(formatUsd(deps.perDayCap)));
    return failAll("Over the daily limit at approval");
  }
  let result: SettleResult;
  let heldBack: number[] = [];
  try {
    const adapter = deps.adapters[head.chain];
    if (!adapter?.batch) throw new Error(`No batch settlement on ${head.chain}`);
    const wallet = await getWallet(deps.db, head.senderId, head.chain);
    if (!wallet) throw new Error("Missing sender wallet");
    const balance = await adapter.getBalance(wallet.address);
    if (balance < pays) {
      await notify(deps, sender.phone, replies.insufficientNow(formatUsd(balance)));
      return failAll("Insufficient balance at approval");
    }
    await notify(deps, sender.phone, splitReplies.sending(formatUsd(pays), legs.length, chainLabel(head.chain)));
    const fromSecret = await unsealWallet(wallet, deps.walletKey);
    result = await adapter.batch.settleBatch({
      fromSecret,
      legs: legs.map((l) => ({ to: l.recipientAddress, amount: l.amount, memo: l.id })),
    });
  } catch (e) {
    const error = errorText(e);
    if (e instanceof TransferUnconfirmedError) {
      // It went out and may still land: never call it failed, and never send it again (that could pay twice).
      // Every leg waits on the one transaction until reconcileSplit learns from the chain what became of it.
      for (const leg of legs) await markTransferUnconfirmed(deps.db, leg.id, e.txHash);
      await notify(deps, sender.phone, splitReplies.unconfirmed(formatUsd(pays)));
      return { ok: false, reason: "unconfirmed", error };
    }
    if (!(e instanceof HeldBackError)) {
      await notify(deps, sender.phone, replies.failed());
      return failAll(error);
    }
    // It landed, but the chain kept some shares from their recipients. The rest were paid.
    ({ result, heldBack } = e);
  }
  const markNow: FinishLeg = async (leg, end) => {
    if (end.status === "failed") await markFailed(deps.db, leg.id, end.error);
    else if (end.status === "escrowed") await markEscrowed(deps.db, leg.id, end, end.escrowExpiresAt);
    else await markSettled(deps.db, leg.id, end, end.settledAt);
    return true;
  };
  return (await deliverSplit(deps, { sender, head, legs, people: people as User[], result, heldBack }, markNow)).outcome;
}

type LegEnd =
  | { status: "settled"; txHash: string; explorerUrl: string | null; settledAt: Date }
  | { status: "escrowed"; txHash: string; explorerUrl: string | null; escrowExpiresAt: Date }
  | { status: "failed"; error: string };
/** Records how one leg ended. False when it was already finished elsewhere, so nobody hears about it twice. */
type FinishLeg = (leg: Intent, end: LegEnd) => Promise<boolean>;

/**
 * A split's transaction landed: each leg is settled (or escrowed, for someone not on Dial yet) unless the chain
 * held it back, which fails that leg alone. Every leg is recorded before anyone is texted, stopping at the first
 * one another run already finished (that run owns the split). Then every recipient paid hears about it, and the
 * sender gets one receipt saying which shares arrived and which didn't.
 */
async function deliverSplit(
  deps: BotDeps,
  split: { sender: User; head: Intent; legs: Intent[]; people: User[]; result: SettleResult; heldBack: number[] },
  finish: FinishLeg,
): Promise<{ outcome: SettleOutcome; delivered: number; held: number }> {
  const { sender, head, legs, people, result, heldBack } = split;
  const now = deps.now();
  const escrowExpiresAt = new Date(now.getTime() + deps.escrowTtlDays * DAY_MS);
  const ended: Array<{ leg: Intent; person: User; end: LegEnd }> = [];
  for (const [i, leg] of legs.entries()) {
    const end: LegEnd = heldBack.includes(i)
      ? { status: "failed", error: `Held back by a transfer policy in ${result.txHash}` }
      : leg.escrowSecretEnc
        ? { status: "escrowed", ...result, escrowExpiresAt }
        : { status: "settled", ...result, settledAt: now };
    if (!(await finish(leg, end))) break;
    ended.push({ leg, person: people[i] as User, end });
  }
  const chain = chainLabel(head.chain);
  const delivered: Array<{ amount: bigint; person: User }> = [];
  const held: Array<{ amount: bigint; person: User }> = [];
  const waiting: string[] = [];
  for (const { leg, person, end } of ended) {
    const amount = formatUsd(leg.amount);
    if (end.status === "failed") {
      held.push({ amount: leg.amount, person });
    } else if (end.status === "escrowed") {
      delivered.push({ amount: leg.amount, person });
      waiting.push(shortName(person));
      if (!(await isOptedOut(deps.db, person.phone))) {
        await notify(deps, person.phone, replies.receivedUnclaimed(amount, displayName(sender), leg.note, `${deps.appUrl}/a/${leg.id}`));
      }
    } else {
      delivered.push({ amount: leg.amount, person });
      await notify(deps, person.phone, replies.received(displayName(person), amount, displayName(sender), chain, leg.note, receiptUrl(deps, leg, result)));
    }
  }
  const counts = { delivered: delivered.length, held: held.length };
  if (ended.length === 0) return { outcome: { ok: false, reason: "not_claimable" }, ...counts };
  const receipt = receiptUrl(deps, head, result);
  await notify(
    deps,
    sender.phone,
    held.length
      ? splitReplies.partlySent(delivered.length ? sharesText(delivered) : null, sharesText(held), chain, receipt, waiting, deps.escrowTtlDays)
      : splitReplies.sent(sharesText(delivered), chain, receipt, waiting, deps.escrowTtlDays),
  );
  if (delivered.length === 0) return { outcome: { ok: false, reason: "failed", error: "Every share was held back" }, ...counts };
  return { outcome: { ok: true, status: waiting.length === delivered.length ? "escrowed" : "settled", ...result }, ...counts };
}

/**
 * A split whose one transaction (`txHash`) went out without an answer (approveSplit); `head` is one of its legs. `ask` gets the chain's
 * word on it for the legs still waiting. Landed: they settle at once, as if it had confirmed straight away, and
 * the sender gets one receipt. Can't land any more: they fail, and the sender hears once. Otherwise they wait
 * for the next run. From reconcileTransfers.
 */
export async function reconcileSplit(
  deps: BotDeps,
  head: Intent & { splitId: string },
  txHash: string,
  ask: (legs: Array<{ to: string; amount: bigint }>) => Promise<TransferOutcome | null>,
): Promise<{ settled: number; failed: number }> {
  const done = { settled: 0, failed: 0 };
  const legs = (await splitLegs(deps.db, head.splitId)).filter((l) => unconfirmedTransferTx(l) === txHash);
  const outcome = await ask(legs.map((l) => ({ to: l.recipientAddress, amount: l.amount })));
  if (!outcome || outcome.state === "pending") return done;
  const [sender, ...people] = await Promise.all([head.senderId, ...legs.map((l) => l.recipientId)].map((id) => getUserById(deps.db, id)));
  if (!sender || people.some((p) => !p)) return done;
  const finish: FinishLeg = (leg, end) => finishUnconfirmedTransfer(deps.db, leg, end);
  if (outcome.state === "failed") {
    for (const leg of legs) {
      if (!(await finish(leg, { status: "failed", error: `Transaction ${txHash} did not land` }))) break;
      done.failed++;
    }
    if (done.failed > 0) await notify(deps, sender.phone, replies.failed());
    return done;
  }
  const split = { sender, head, legs, people: people as User[], result: outcome.result, heldBack: outcome.heldBack ?? [] };
  const r = await deliverSplit(deps, split, finish);
  return { settled: r.delivered, failed: r.held };
}

/**
 * "Did it work?" about a split the sender started: the whole split, not one leg. Null when the plain
 * per-payment status says it better (expired, failed, cancelled, or a leg seen from the recipient's side).
 */
export async function splitStatusReply(
  deps: BotDeps,
  user: User,
  leg: Intent,
  { freshCode }: { freshCode: boolean },
): Promise<string | null> {
  if (!leg.splitId || leg.senderId !== user.id) return null;
  const legs = await splitLegs(deps.db, leg.splitId);
  const people = await Promise.all(legs.map((l) => getUserById(deps.db, l.recipientId)));
  if (people.some((p) => !p)) return null;
  const shares = sharesText(legs.map((l, i) => ({ amount: l.amount, person: people[i] as User })));
  const total = formatUsd(legs.reduce((a, l) => a + l.amount, 0n));
  const now = deps.now();
  switch (leg.status) {
    case "pending": {
      if (leg.expiresAt <= now || !freshCode || legs.some(isCodeLocked)) return null;
      const code = await splitCode(deps, user.id, legs, true);
      return splitReplies.statusWaitingOnYou(total, shares, code, `${deps.appUrl}/a/${legs[0]?.id ?? leg.id}`);
    }
    case "settling":
      return splitReplies.statusSending(total);
    case "settled":
    case "escrowed":
      return splitReplies.statusSent(shares, receiptUrl(deps, leg, leg));
    default:
      return null;
  }
}

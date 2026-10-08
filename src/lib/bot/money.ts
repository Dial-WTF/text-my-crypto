import { z } from "zod";
import { CHAINS, chainLabel } from "@/lib/chains";
import { findContact } from "@/lib/contacts";
import { setConversation } from "@/lib/conversations";
import type { User } from "@/lib/db/schema";
import {
  createUnclaimedUser,
  describe,
  displayName,
  findUserByHandle,
  findUserByPhone,
  isClaimed,
  searchDirectory,
} from "@/lib/identity";
import { createIntent, issueCode, sentSince } from "@/lib/intents";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import type { MoneyCommand, WithdrawCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { hasPasskey } from "@/lib/passkeys";
import { normalizePhone } from "@/lib/phone";
import { seal } from "@/lib/secretbox";
import { ensureWallet } from "./accounts";
import { text } from "./text";
import type { BotDeps } from "./types";

export const moneyCommandSchema = z.object({
  kind: z.enum(["send", "request", "invoice"]),
  counterparty: z.string(),
  amountUsd: z.string(),
  note: z.string().optional(),
  chain: z.enum(CHAINS).optional(),
});

type Resolved = { user: User } | { askFor: string } | { choose: User[] } | { error: string };

/**
 * Who does the sender mean? Like an operator: @handle and numbers connect directly; then the sender's
 * own contacts; then the directory. One directory match connects (the confirmation names them),
 * several ask the sender to pick, none asks for a number.
 */
async function resolveCounterparty(deps: BotDeps, owner: User, raw: string): Promise<Resolved> {
  if (raw.startsWith("@")) {
    const u = await findUserByHandle(deps.db, raw.slice(1));
    return u ? { user: u } : { error: replies.unknownHandle(raw) };
  }
  const phone = normalizePhone(raw) ?? (await findContact(deps.db, owner.id, raw))?.phone ?? null;
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
async function codeFor(deps: BotDeps, payerId: string, intentId: string, amount: bigint): Promise<string | null> {
  if (amount > deps.passkeyThreshold && (await hasPasskey(deps.db, payerId))) return null;
  return issueCode(deps.db, intentId);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Validates a send/request/invoice and creates its PaymentIntent. Returns the reply for the person who texted. */
export async function prepareMoney(deps: BotDeps, user: User, cmd: MoneyCommand): Promise<string> {
  const chain = cmd.chain ?? user.defaultChain;
  const adapter = deps.adapters[chain];
  if (!adapter) return replies.chainUnavailable(chainLabel(chain));

  const amount = usdToBaseUnits(cmd.amountUsd);
  if (amount <= 0n) return replies.help();
  if (amount > deps.perTxCap) return replies.overCap(formatUsd(deps.perTxCap));

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

  const mine = await ensureWallet(deps, user.id, chain, adapter);
  const note = cmd.note ?? null;
  const otherName = describe(other);
  const me = displayName(user);

  if (cmd.kind === "send") {
    const balance = await adapter.getBalance(mine.address);
    if (balance < amount) return replies.insufficient(formatUsd(balance));
    const today = await sentSince(deps.db, user.id, startOfUtcDay(deps.now()));
    if (today + amount > deps.perDayCap) return replies.overDaily(formatUsd(deps.perDayCap));

    let recipientAddress: string;
    let escrowSecretEnc: string | null = null;
    if (isClaimed(other)) {
      recipientAddress = (await ensureWallet(deps, other.id, chain, adapter)).address;
    } else {
      const escrow = await adapter.createWallet();
      recipientAddress = escrow.address;
      escrowSecretEnc = await seal(escrow.secret, deps.walletKey);
    }
    const intent = await createIntent(
      deps.db,
      {
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
      },
      deps.now(),
    );
    const code = await codeFor(deps, user.id, intent.id, amount);
    return replies.confirmSend(formatUsd(amount), otherName, chainLabel(chain), note, code, `${deps.appUrl}/a/${intent.id}`);
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
  const link = `${deps.appUrl}/a/${intent.id}`;
  if (cmd.kind === "request") {
    await text(deps, other.phone, replies.payRequest(me, formatUsd(amount), note, code, link));
    return replies.requestSent(formatUsd(amount), otherName);
  }
  await text(deps, other.phone, replies.payInvoice(me, formatUsd(amount), note, code, link));
  return replies.invoiceSent(formatUsd(amount), otherName, link);
}

function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** Moves funds out to an address the user controls. Same code/limit rules as a send. */
export async function prepareWithdraw(deps: BotDeps, user: User, cmd: WithdrawCommand): Promise<string> {
  const chain = cmd.chain ?? user.defaultChain;
  const adapter = deps.adapters[chain];
  if (!adapter) return replies.chainUnavailable(chainLabel(chain));
  if (!adapter.isValidAddress(cmd.address)) return replies.badAddress(chainLabel(chain));

  const mine = await ensureWallet(deps, user.id, chain, adapter);
  const balance = await adapter.getBalance(mine.address);
  const amount = cmd.amountUsd === "all" ? balance : usdToBaseUnits(cmd.amountUsd);
  if (amount <= 0n) return replies.nothingToWithdraw();
  if (amount > deps.perTxCap) return replies.overCap(formatUsd(deps.perTxCap));
  if (balance < amount) return replies.insufficient(formatUsd(balance));
  const today = await sentSince(deps.db, user.id, startOfUtcDay(deps.now()));
  if (today + amount > deps.perDayCap) return replies.overDaily(formatUsd(deps.perDayCap));

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
  return replies.confirmWithdraw(
    formatUsd(amount),
    shortAddress(cmd.address),
    chainLabel(chain),
    code,
    `${deps.appUrl}/a/${intent.id}`,
  );
}

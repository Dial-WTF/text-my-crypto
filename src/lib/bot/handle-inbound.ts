import { type Chain, CHAINS, chainLabel } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import type { User } from "@/lib/db/schema";
import {
  createSignupToken,
  createUnclaimedUser,
  displayName,
  findUserByPhone,
  getUserById,
  isClaimed,
  resolveRecipient,
} from "@/lib/identity";
import { createIntent, latestSettledTo } from "@/lib/intents";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import { interpret, type LlmInterpreter } from "@/lib/operator/brain";
import type { MoneyCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { normalizePhone } from "@/lib/phone";
import type { Adapters, SettlementAdapter } from "@/lib/settlement/types";
import type { InboundSms } from "@/lib/sms/inbound";
import { logInbound, logOutbound } from "@/lib/sms/log";
import type { SendSms } from "@/lib/sms/payphone";
import { addWallet, getWallet } from "@/lib/wallets";

export type BotDeps = {
  db: Db;
  sendSms: SendSms;
  llm: LlmInterpreter;
  adapters: Adapters;
  appUrl: string;
  now: () => Date;
  perTxCap: bigint;
  walletKey: string;
};

export async function handleInbound(deps: BotDeps, msg: InboundSms): Promise<string[]> {
  if (!(await logInbound(deps.db, msg))) return [];

  const out: string[] = [];
  const reply = async (text: string) => {
    out.push(text);
    await text_(deps, msg.from, text);
  };

  const user = await findUserByPhone(deps.db, msg.from);
  if (!user || !isClaimed(user)) {
    await reply(await welcome(deps, msg.from, user));
    return out;
  }

  const turn = await interpret(msg.body, deps.llm);
  switch (turn.command.kind) {
    case "help":
      await reply(replies.help());
      break;
    case "chat":
      await reply(turn.reply ?? replies.chatFallback());
      break;
    case "balance":
      await reply(await balanceReply(deps, user));
      break;
    case "receive":
      await reply(await receiveReply(deps, user));
      break;
    case "send":
    case "request":
    case "invoice":
      await reply(await prepareMoney(deps, user, turn.command));
      break;
  }
  return out;
}

async function text_(deps: BotDeps, phone: string, body: string): Promise<void> {
  await deps.sendSms(phone, body);
  await logOutbound(deps.db, phone, body);
}

async function welcome(deps: BotDeps, phone: string, user: User | null): Promise<string> {
  const link = `${deps.appUrl}/s/${await createSignupToken(deps.db, phone, deps.now())}`;
  if (user) {
    const waiting = await latestSettledTo(deps.db, user.id);
    const sender = waiting ? await getUserById(deps.db, waiting.senderId) : null;
    if (waiting && sender) return replies.welcomeWithMoney(formatUsd(waiting.amount), displayName(sender), link);
  }
  return replies.welcome(link);
}

function enabledChains(deps: BotDeps): Array<[Chain, SettlementAdapter]> {
  return CHAINS.flatMap((c) => {
    const a = deps.adapters[c];
    return a ? [[c, a] as [Chain, SettlementAdapter]] : [];
  });
}

async function balanceReply(deps: BotDeps, user: User): Promise<string> {
  const lines: string[] = [];
  for (const [chain, adapter] of enabledChains(deps)) {
    const w = await getWallet(deps.db, user.id, chain);
    if (w) lines.push(`${formatUsd(await adapter.getBalance(w.address))} USDC on ${chainLabel(chain)}`);
  }
  return lines.length ? replies.balance(lines) : replies.chainUnavailable(chainLabel(user.defaultChain));
}

async function receiveReply(deps: BotDeps, user: User): Promise<string> {
  const addresses: string[] = [];
  for (const [chain] of enabledChains(deps)) {
    const w = await getWallet(deps.db, user.id, chain);
    if (w) addresses.push(`${chainLabel(chain)}: ${w.address}`);
  }
  return replies.receive(user.handle ?? displayName(user), addresses);
}

async function ensureWallet(deps: BotDeps, userId: string, chain: Chain, adapter: SettlementAdapter) {
  const existing = await getWallet(deps.db, userId, chain);
  if (existing) return existing;
  const w = await adapter.createWallet();
  await addWallet(deps.db, { userId, chain, address: w.address, secret: w.secret, keyB64: deps.walletKey });
  const created = await getWallet(deps.db, userId, chain);
  if (!created) throw new Error("wallet creation failed");
  return created;
}

async function resolveOrCreate(deps: BotDeps, raw: string): Promise<User | null> {
  const found = await resolveRecipient(deps.db, raw);
  if (found) return found;
  const phone = normalizePhone(raw);
  return phone ? createUnclaimedUser(deps.db, phone) : null;
}

async function prepareMoney(deps: BotDeps, user: User, cmd: MoneyCommand): Promise<string> {
  const chain = cmd.chain ?? user.defaultChain;
  const adapter = deps.adapters[chain];
  if (!adapter) return replies.chainUnavailable(chainLabel(chain));

  const amount = usdToBaseUnits(cmd.amountUsd);
  if (amount <= 0n) return replies.help();
  if (amount > deps.perTxCap) return replies.overCap(formatUsd(deps.perTxCap));

  const other = await resolveOrCreate(deps, cmd.counterparty);
  if (!other) return replies.unknownRecipient(cmd.counterparty);
  if (other.id === user.id) return replies.selfSend();

  const [mine, theirs] = await Promise.all([
    ensureWallet(deps, user.id, chain, adapter),
    ensureWallet(deps, other.id, chain, adapter),
  ]);
  const note = cmd.note ?? null;
  const otherName = displayName(other);

  if (cmd.kind === "send") {
    const balance = await adapter.getBalance(mine.address);
    if (balance < amount) return replies.insufficient(formatUsd(balance));
    const intent = await createIntent(
      deps.db,
      { kind: "send", createdBy: user.id, senderId: user.id, recipientId: other.id, chain, token: adapter.tokenId, recipientAddress: theirs.address, amount, note },
      deps.now(),
    );
    return replies.confirmSend(formatUsd(amount), otherName, chainLabel(chain), note, `${deps.appUrl}/a/${intent.id}`);
  }

  const intent = await createIntent(
    deps.db,
    { kind: cmd.kind, createdBy: user.id, senderId: other.id, recipientId: user.id, chain, token: adapter.tokenId, recipientAddress: mine.address, amount, note },
    deps.now(),
  );
  const link = `${deps.appUrl}/a/${intent.id}`;
  const me = displayName(user);
  if (cmd.kind === "request") {
    await text_(deps, other.phone, replies.payRequest(me, formatUsd(amount), note, link));
    return replies.requestSent(formatUsd(amount), otherName);
  }
  await text_(deps, other.phone, replies.payInvoice(me, formatUsd(amount), note, link));
  return replies.invoiceSent(formatUsd(amount), otherName, link);
}

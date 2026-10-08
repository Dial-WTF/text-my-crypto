import { chainLabel } from "@/lib/chains";
import { CODE_RE } from "@/lib/codes";
import { saveContact } from "@/lib/contacts";
import { clearConversation, getConversation, setConversation } from "@/lib/conversations";
import type { User } from "@/lib/db/schema";
import { createSignupToken, displayName, findUserByPhone, getUserById, isClaimed } from "@/lib/identity";
import { codeCandidates, latestSettledTo, matchCode } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { interpret } from "@/lib/operator/brain";
import { replies } from "@/lib/operator/replies";
import { normalizePhone } from "@/lib/phone";
import type { InboundSms } from "@/lib/sms/inbound";
import { logInbound } from "@/lib/sms/log";
import { getWallet } from "@/lib/wallets";
import { completeSignup, enabledChains } from "./accounts";
import { moneyCommandSchema, prepareMoney } from "./money";
import { approveIntent, declineLatest, reclaimExpired, releaseEscrow } from "./settle";
import { text } from "./text";
import type { BotDeps } from "./types";

export type { BotDeps } from "./types";

export async function handleInbound(deps: BotDeps, msg: InboundSms): Promise<string[]> {
  if (!(await logInbound(deps.db, msg))) return [];

  const out: string[] = [];
  const reply = async (body: string) => {
    out.push(body);
    await text(deps, msg.from, body);
  };

  const user = await findUserByPhone(deps.db, msg.from);
  const convo = await getConversation(deps.db, msg.from, deps.now());

  if (!user || !isClaimed(user)) {
    if (convo?.state === "awaiting_name" && !CODE_RE.test(msg.body)) {
      const result = await completeSignup(deps, msg.from, msg.body);
      if (result.ok) await clearConversation(deps.db, msg.from);
      await reply(result.ok ? result.reply : result.error);
      return out;
    }
    await setConversation(deps.db, msg.from, { state: "awaiting_name", payload: {} }, deps.now());
    await reply(await welcome(deps, user));
    return out;
  }

  if (CODE_RE.test(msg.body)) {
    for (const r of await handleCode(deps, user, msg.body)) await reply(r);
    return out;
  }

  if (convo?.state === "awaiting_number") {
    await clearConversation(deps.db, msg.from);
    const phone = normalizePhone(msg.body);
    const parsed = moneyCommandSchema.safeParse(JSON.parse(convo.payload.command));
    if (phone && parsed.success) {
      await saveContact(deps.db, user.id, convo.payload.name, phone);
      await reply(await prepareMoney(deps, user, { ...parsed.data, counterparty: phone }));
      return out;
    }
  }

  const turn = await interpret(msg.body, deps.llm);
  const cmd = turn.command;
  switch (cmd.kind) {
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
    case "reclaim":
      await reply(await reclaimExpired(deps, user.id));
      break;
    case "decline":
      await reply(await declineLatest(deps, user.id));
      break;
    case "upgrade":
      await reply(replies.upgrade(`${deps.appUrl}/s/${await createSignupToken(deps.db, user.phone, deps.now())}`));
      break;
    case "send":
    case "request":
    case "invoice":
      await reply(await prepareMoney(deps, user, cmd));
      break;
  }
  return out;
}

async function welcome(deps: BotDeps, user: User | null): Promise<string> {
  if (user) {
    const waiting = await latestSettledTo(deps.db, user.id);
    const sender = waiting ? await getUserById(deps.db, waiting.senderId) : null;
    if (waiting && sender) return replies.welcomeWithMoney(formatUsd(waiting.amount), displayName(sender));
  }
  return replies.welcome();
}

async function handleCode(deps: BotDeps, user: User, code: string): Promise<string[]> {
  const matches = await matchCode(deps.db, await codeCandidates(deps.db, user.id, deps.now()), code);
  if (matches.length === 0) return [replies.codeMismatch()];
  const failures: string[] = [];
  for (const intent of matches) {
    const outcome =
      intent.status === "escrowed" ? await releaseEscrow(deps, intent.id) : await approveIntent(deps, intent.id);
    if (!outcome.ok && outcome.reason === "not_claimable") failures.push(replies.codeMismatch());
  }
  return failures;
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

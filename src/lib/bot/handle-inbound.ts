import { chainLabel } from "@/lib/chains";
import { MAX_CODE_ATTEMPTS } from "@/lib/codes";
import { saveContact } from "@/lib/contacts";
import { clearConversation, type Conversation, getConversation, setConversation } from "@/lib/conversations";
import type { User } from "@/lib/db/schema";
import {
  createSignupToken,
  describe,
  displayName,
  findUserByPhone,
  getUserById,
  isClaimed,
  renameUser,
  searchDirectory,
} from "@/lib/identity";
import {
  cancelUnapproved,
  codeCandidates,
  hasAwaitingApproval,
  hasLockedCode,
  latestSettledTo,
  matchCode,
  matchesExpiredCode,
} from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { cleanDisplayName } from "@/lib/names";
import { interpret } from "@/lib/operator/brain";
import { replies } from "@/lib/operator/replies";
import type { InboundSms } from "@/lib/sms/inbound";
import { isBurstRepeat, logInbound, recentHistory } from "@/lib/sms/log";
import { isOptedOut, optIn, optOut } from "@/lib/sms/optout";
import { getWallet } from "@/lib/wallets";
import { completeSignup, enabledChains, offerWaiting } from "./accounts";
import { connectAgentReply, revokeAgentsReply } from "./agents";
import { type Action, decide, type Session } from "./machine/decide";
import { classify } from "./machine/classify";
import { moneyCommandSchema, prepareMoney, prepareWithdraw } from "./money";
import { approveIntent, declineLatest, reclaimExpired, releaseEscrow } from "./settle";
import { text } from "./text";
import type { BotDeps } from "./types";

export type { BotDeps } from "./types";

const BURST_MS = 60_000;

/**
 * One inbound text, start to finish: log (dropping redeliveries), drop double-taps, load what the
 * operator knows about this number, classify the text, decide the single action, do it.
 */
export async function handleInbound(deps: BotDeps, msg: InboundSms): Promise<string[]> {
  const logId = await logInbound(deps.db, msg, deps.now());
  if (!logId) return [];
  if (await isBurstRepeat(deps.db, logId, msg.from, msg.body, new Date(deps.now().getTime() - BURST_MS))) return [];

  const user = await findUserByPhone(deps.db, msg.from);
  const session = await loadSession(deps, msg.from, user);
  const action = decide(session, classify(msg.body));

  const out: string[] = [];
  const reply = async (body: string, force = false) => {
    if (await text(deps, msg.from, body, { force })) out.push(body);
  };
  await act(deps, action, { phone: msg.from, body: msg.body, user, convo: session.convo, reply });
  return out;
}

async function loadSession(deps: BotDeps, phone: string, user: User | null): Promise<Session> {
  const claimed = user !== null && isClaimed(user);
  return {
    account: !user ? "unknown" : claimed ? "claimed" : "unclaimed",
    optedOut: await isOptedOut(deps.db, phone),
    convo: await getConversation(deps.db, phone, deps.now()),
    awaitingApproval: claimed ? await hasAwaitingApproval(deps.db, user.id, deps.now()) : false,
  };
}

type Ctx = {
  phone: string;
  body: string;
  user: User | null;
  convo: Conversation | null;
  reply: (body: string, force?: boolean) => Promise<void>;
};

async function act(deps: BotDeps, action: Action, ctx: Ctx): Promise<void> {
  const { phone, reply } = ctx;
  switch (action.do) {
    case "silence":
      return;
    case "optOut":
      await optOut(deps.db, phone, deps.now());
      return reply(replies.optedOut(), true);
    case "optIn":
      await optIn(deps.db, phone);
      return reply(replies.optedIn());
    case "help":
      return reply(replies.help());
    case "welcome":
      await setConversation(deps.db, phone, { state: "awaiting_name", payload: {} }, deps.now());
      return reply(await welcome(deps, ctx.user));
    case "nameFirst":
      return reply(replies.nameFirst());
    case "badName":
      return reply(replies.badName());
    case "signup": {
      const result = await completeSignup(deps, phone, action.name);
      if (!result.ok) return reply(result.error);
      await clearConversation(deps.db, phone);
      await reply(result.reply);
      return offerWaiting(deps, result.user);
    }
  }

  const user = ctx.user;
  if (!user) return reply(replies.welcome());

  switch (action.do) {
    case "approve":
      for (const r of await approveByCode(deps, user, action.code)) await reply(r);
      return;
    case "codeHint":
      return reply(replies.codeHint());
    case "nevermind":
      await clearConversation(deps.db, phone);
      return reply(replies.cancelled(await cancelUnapproved(deps.db, user.id, deps.now())));
    case "confirmNew":
    case "pick":
    case "useNumber":
      return reply(await answerPrompt(deps, user, ctx.convo, action));
    case "command":
      return runCommand(deps, user, action.text, reply);
  }
}

/** Replies to "1", a phone number, or NEW after the operator asked a question. */
async function answerPrompt(
  deps: BotDeps,
  user: User,
  convo: Conversation | null,
  action: Extract<Action, { do: "confirmNew" | "pick" | "useNumber" }>,
): Promise<string> {
  await clearConversation(deps.db, user.phone);
  if (!convo || convo.state === "awaiting_name") return replies.chatFallback();
  const parsed = moneyCommandSchema.safeParse(JSON.parse(convo.payload.command));
  if (!parsed.success) return replies.chatFallback();
  if (action.do === "confirmNew") return prepareMoney(deps, user, parsed.data, { allowDuplicate: true });
  if (action.do === "useNumber") {
    if (convo.state !== "awaiting_duplicate") await saveContact(deps.db, user.id, convo.payload.name, action.phone);
    return prepareMoney(deps, user, { ...parsed.data, counterparty: action.phone });
  }
  const handle = convo.state === "awaiting_choice" ? convo.payload.handles[action.index] : undefined;
  return handle ? prepareMoney(deps, user, { ...parsed.data, counterparty: `@${handle}` }) : replies.chatFallback();
}

async function runCommand(deps: BotDeps, user: User, body: string, reply: (b: string) => Promise<void>): Promise<void> {
  await clearConversation(deps.db, user.phone);
  const turn = await interpret(body, deps.llm, await recentHistory(deps.db, user.phone));
  const cmd = turn.command;
  switch (cmd.kind) {
    case "help":
      return reply(replies.help());
    case "chat":
      return reply(turn.reply ?? replies.chatFallback());
    case "balance":
      return reply(await balanceReply(deps, user));
    case "receive":
      return reply(await receiveReply(deps, user));
    case "reclaim":
      return reply(await reclaimExpired(deps, user.id));
    case "decline":
      return reply(await declineLatest(deps, user.id));
    case "directory": {
      const found = await searchDirectory(deps.db, cmd.query, 3);
      return reply(replies.directory(cmd.query, found.map(describe)));
    }
    case "rename": {
      const name = cleanDisplayName(cmd.name);
      const renamed = name ? await renameUser(deps.db, user.id, name) : null;
      return reply(renamed && name ? replies.renamed(name, renamed.handle ?? "") : replies.badName());
    }
    case "whoami":
      return reply(replies.whoami(displayName(user), user.handle ?? ""));
    case "upgrade":
      return reply(replies.upgrade(`${deps.appUrl}/s/${await createSignupToken(deps.db, user.phone, deps.now())}`));
    case "connect_agent":
      return reply(await connectAgentReply(deps, user, cmd.label));
    case "revoke_agents":
      return reply(await revokeAgentsReply(deps, user));
    case "send":
    case "request":
    case "invoice":
      return reply(await prepareMoney(deps, user, cmd));
    case "withdraw":
      return reply(await prepareWithdraw(deps, user, cmd));
  }
}

async function welcome(deps: BotDeps, user: User | null): Promise<string> {
  if (user) {
    const waiting = await latestSettledTo(deps.db, user.id);
    const sender = waiting ? await getUserById(deps.db, waiting.senderId) : null;
    if (waiting && sender) return replies.welcomeWithMoney(formatUsd(waiting.amount), displayName(sender));
  }
  return replies.welcome();
}

/** A 6-digit reply: approve the payment it belongs to, release an escrow, or explain why not. */
async function approveByCode(deps: BotDeps, user: User, code: string): Promise<string[]> {
  const candidates = await codeCandidates(deps.db, user.id, deps.now());
  const matches = await matchCode(deps.db, candidates, code);
  if (matches.length === 0) {
    if (await matchesExpiredCode(deps.db, user.id, code, deps.now())) return [replies.codeExpired()];
    if (candidates.length === 0) {
      return [(await hasLockedCode(deps.db, user.id, deps.now())) ? replies.codeMismatch(0) : replies.noCodePending()];
    }
    const used = Math.max(...candidates.map((c) => c.codeAttempts)) + 1;
    return [replies.codeMismatch(Math.max(0, MAX_CODE_ATTEMPTS - used))];
  }
  const notes: string[] = [];
  for (const intent of matches) {
    const outcome =
      intent.status === "escrowed" ? await releaseEscrow(deps, intent.id) : await approveIntent(deps, intent.id);
    if (!outcome.ok && outcome.reason === "not_claimable") notes.push(replies.codeMismatch());
  }
  return notes;
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

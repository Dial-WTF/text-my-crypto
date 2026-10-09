import { type Chain, chainLabel } from "@/lib/chains";
import { MAX_CODE_ATTEMPTS } from "@/lib/codes";
import { saveContact } from "@/lib/contacts";
import {
  clearConversationIf,
  type Conversation,
  getConversation,
  type LoadedConversation,
  setConversation,
} from "@/lib/conversations";
import type { Intent, User } from "@/lib/db/schema";
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
  expiredEscrowForCode,
  hasAwaitingApproval,
  hasLockedCode,
  latestSettledTo,
  matchCode,
  matchesExpiredCode,
} from "@/lib/intents";
import { money, namesItsCoin } from "@/lib/settlement/amounts";
import { cleanDisplayName } from "@/lib/names";
import { interpret } from "@/lib/operator/brain";
import { replies } from "@/lib/operator/replies";
import { ChainDownError } from "@/lib/settlement/types";
import type { InboundSms } from "@/lib/sms/inbound";
import { isBurstRepeat, lastOutbound, logInbound, recentHistory } from "@/lib/sms/log";
import { isOptedOut, optIn, optOut } from "@/lib/sms/optout";
import { getWallet } from "@/lib/wallets";
import { completeSignup, enabledChains, expiredClaimReply, offerWaiting, retryEscrowClaims } from "./accounts";
import { connectAgentReply, revokeAgentsReply } from "./agents";
import { endSessionsForUser } from "@/lib/web/sessions";
import { walletLinkReply } from "./web";
import { type Action, decide, type Session } from "./machine/decide";
import { classify } from "./machine/classify";
import { moneyCommandSchema, prepareMoney, prepareWithdraw, withdrawCommandSchema } from "./money";
import { approveIntent, declineLatest, reclaimExpired, releaseEscrow } from "./settle";
import { latestRecent, needsMention, statusReply } from "./status";
import { text } from "./text";
import type { BotDeps } from "./types";

export type { BotDeps } from "./types";

const BURST_MS = 60_000;
const MONEY_VERB = /^\s*(?:please\s+)?(?:send|pay|give|transfer|request|ask|charge|invoice|bill|withdraw)\b/i;

/**
 * One inbound text, start to finish: log (dropping redeliveries), drop double-taps, load what the
 * operator knows about this number, classify the text, decide the single action, do it.
 */
export async function handleInbound(deps: BotDeps, msg: InboundSms): Promise<string[]> {
  const logId = await logInbound(deps.db, msg, deps.now());
  if (!logId) return [];
  if (await isBurstRepeat(deps.db, logId, msg.from, msg.body, new Date(deps.now().getTime() - BURST_MS))) return [];

  const user = await findUserByPhone(deps.db, msg.from);
  const loaded = await getConversation(deps.db, msg.from, deps.now());
  const session = await loadSession(deps, msg.from, user, loaded);
  const action = decide(session, classify(msg.body));

  const out: string[] = [];
  const reply = async (body: string, force = false) => {
    if (await text(deps, msg.from, body, { force })) out.push(body);
  };
  try {
    await act(deps, action, { phone: msg.from, body: msg.body, user, convo: session.convo, reply });
  } catch (e) {
    // A chain RPC that won't answer is not worth retrying for minutes: say so now. Anything else retries.
    if (!(e instanceof ChainDownError)) throw e;
    console.error("chain down", e.message);
    await reply(replies.chainDown(chainLabel(e.chain)));
    return out;
  }
  // Only now, after the action and its reply succeeded, is the question it answered (or abandoned) used up.
  // If anything above threw, the question is still there for the retry.
  if (loaded && CONSUMES_QUESTION.has(action.do)) await clearConversationIf(deps.db, msg.from, loaded.rev);
  return out;
}

const CONSUMES_QUESTION = new Set<Action["do"]>(["signup", "nevermind", "confirmNew", "pick", "useNumber", "useChain", "command"]);

async function loadSession(
  deps: BotDeps,
  phone: string,
  user: User | null,
  convo: LoadedConversation | null,
): Promise<Session> {
  const claimed = user !== null && isClaimed(user);
  return {
    account: !user ? "unknown" : claimed ? "claimed" : "unclaimed",
    optedOut: await isOptedOut(deps.db, phone),
    convo,
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
    case "optOut": {
      // CANCEL is a carrier opt-out word, but it may also mean "cancel my payment": do both, and say so.
      const cancelled = action.cancelPending && ctx.user ? await cancelUnapproved(deps.db, ctx.user.id, deps.now()) : 0;
      await optOut(deps.db, phone, deps.now());
      // Opting out also signs them out of the wallet on the web: STOP means stop everything.
      if (ctx.user) await endSessionsForUser(deps.db, ctx.user.id, deps.now());
      return reply(replies.optedOut(cancelled > 0), true);
    }
    case "optIn":
      await optIn(deps.db, phone);
      await reply(replies.optedIn());
      // Anything sent or asked of them while they were away was held back; offer it now, as at signup.
      if (ctx.user && isClaimed(ctx.user)) await offerWaiting(deps, ctx.user);
      return;
    case "help":
      return helpReplies(deps, reply);
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
      await reply(result.reply);
      return offerWaiting(deps, result.user);
    }
  }

  const user = ctx.user;
  if (!user) return reply(replies.welcome(deps.appUrl));

  switch (action.do) {
    case "approve":
      for (const r of await approveByCode(deps, user, action.code)) await reply(r);
      return;
    case "codeHint":
      return reply(replies.codeHint());
    case "status":
      return reply(await statusReply(deps, user));
    case "thanks":
      return reply(replies.thanks());
    case "nevermind":
      return reply(replies.cancelled(await cancelUnapproved(deps.db, user.id, deps.now())));
    case "confirmNew":
    case "pick":
    case "useNumber":
      return reply(await answerPrompt(deps, user, ctx.convo, action));
    case "useChain":
      return reply(await answerChain(deps, user, ctx.convo, action.chain));
    case "command":
      return runCommand(deps, user, action.text, reply);
  }
}

/** HELP: who this is and where to get help, then the commands. */
async function helpReplies(deps: BotDeps, reply: (b: string) => Promise<void>): Promise<void> {
  await reply(replies.help(deps.appUrl));
  await reply(replies.commands());
}

/** "ethereum" after the operator asked which chain a withdrawal goes out on. */
async function answerChain(deps: BotDeps, user: User, convo: Conversation | null, chain: Chain): Promise<string> {
  if (convo?.state !== "awaiting_chain") return replies.chatFallback();
  const parsed = withdrawCommandSchema.safeParse(JSON.parse(convo.payload.command));
  return parsed.success ? prepareWithdraw(deps, user, { ...parsed.data, chain }) : replies.chatFallback();
}

/** Replies to "1", a phone number, or NEW after the operator asked a question. */
async function answerPrompt(
  deps: BotDeps,
  user: User,
  convo: Conversation | null,
  action: Extract<Action, { do: "confirmNew" | "pick" | "useNumber" }>,
): Promise<string> {
  if (!convo || convo.state === "awaiting_name") return replies.chatFallback();
  const parsed = moneyCommandSchema.safeParse(JSON.parse(convo.payload.command));
  if (!parsed.success) return replies.chatFallback();
  if (action.do === "confirmNew") return prepareMoney(deps, user, parsed.data, { allowDuplicate: true });
  if (action.do === "useNumber") {
    if (convo.state === "awaiting_number" || convo.state === "awaiting_choice") await saveContact(deps.db, user.id, convo.payload.name, action.phone);
    return prepareMoney(deps, user, { ...parsed.data, counterparty: action.phone });
  }
  const handle = convo.state === "awaiting_choice" ? convo.payload.handles[action.index] : undefined;
  return handle ? prepareMoney(deps, user, { ...parsed.data, counterparty: `@${handle}` }) : replies.chatFallback();
}

async function runCommand(deps: BotDeps, user: User, body: string, reply: (b: string) => Promise<void>): Promise<void> {
  const turn = await interpret(body, deps.llm, await recentHistory(deps.db, user.phone));
  const cmd = turn.command;
  switch (cmd.kind) {
    case "help":
      return helpReplies(deps, reply);
    case "chat":
      return reply(await chatReply(deps, user, body, turn.reply));
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
    case "wallet":
      return reply(await walletLinkReply(deps, user));
    case "send":
    case "request":
    case "invoice":
      return reply(await prepareMoney(deps, user, cmd));
    case "withdraw":
      return reply(await prepareWithdraw(deps, user, cmd));
  }
}

/**
 * Anything the operator can't act on. A payment waiting on them comes first (that's usually why
 * they're texting); then the model's reply if there is one; and never the same canned line twice.
 */
async function chatReply(deps: BotDeps, user: User, body: string, modelReply: string | undefined): Promise<string> {
  const latest = await latestRecent(deps, user);
  if (needsMention(latest, user.id, deps.now())) return statusReply(deps, user, latest, { freshCode: false });
  if (modelReply) return modelReply;
  if (MONEY_VERB.test(body)) return replies.didntCatch();
  return (await lastOutbound(deps.db, user.phone)) === replies.chatFallback() ? replies.notSure() : replies.chatFallback();
}

async function welcome(deps: BotDeps, user: User | null): Promise<string> {
  if (user) {
    const latest = await latestSettledTo(deps.db, user.id);
    // An escrow that expired isn't waiting for them any more.
    const expired = latest?.status === "escrowed" && latest.escrowExpiresAt !== null && latest.escrowExpiresAt <= deps.now();
    const waiting = expired ? null : latest;
    const sender = waiting ? await getUserById(deps.db, waiting.senderId) : null;
    if (waiting && sender) return replies.welcomeWithMoney(money(waiting.amount, waiting.chain, deps.network), displayName(sender), deps.appUrl);
  }
  return replies.welcome(deps.appUrl);
}

/** A 6-digit reply: approve the payment it belongs to, release an escrow, or explain why not. */
async function approveByCode(deps: BotDeps, user: User, code: string): Promise<string[]> {
  const candidates = await codeCandidates(deps.db, user.id, deps.now());
  const matches = await matchCode(deps.db, candidates, code);
  if (matches.length === 0) {
    if (await matchesExpiredCode(deps.db, user.id, code, deps.now())) return [replies.codeExpired()];
    const lateClaim = await expiredEscrowForCode(deps.db, user.id, code, deps.now());
    if (lateClaim) return [await expiredClaimReply(deps, lateClaim)];
    if (candidates.length === 0) {
      if (await hasLockedCode(deps.db, user.id, deps.now())) return [replies.codeMismatch(0)];
      // A late or repeated code: say what happened to their latest payment instead of a bare "nothing waiting".
      const latest = await latestRecent(deps, user);
      return [latest && latest.status !== "pending" ? await statusReply(deps, user, latest) : replies.noCodePending()];
    }
    const used = Math.max(...candidates.map((c) => c.codeAttempts)) + 1;
    return [replies.codeMismatch(Math.max(0, MAX_CODE_ATTEMPTS - used))];
  }
  const notes: string[] = [];
  const retry: Intent[] = [];
  for (const intent of matches) {
    if (intent.status === "escrowed") {
      const outcome = await releaseEscrow(deps, intent.id);
      if (outcome.ok) continue;
      if (outcome.reason === "not_claimable") notes.push(replies.codeMismatch());
      else if (outcome.reason === "expired") notes.push(await expiredClaimReply(deps, intent));
      else retry.push(intent);
      continue;
    }
    const outcome = await approveIntent(deps, intent.id);
    if (!outcome.ok && outcome.reason === "not_claimable") notes.push(replies.codeMismatch());
  }
  // The claim code was used up when the claim started; a failed one gets a fresh code.
  if (retry.length > 0) notes.push(await retryEscrowClaims(deps, retry));
  return notes;
}

async function balanceReply(deps: BotDeps, user: User): Promise<string> {
  const lines: string[] = [];
  for (const [chain, adapter] of enabledChains(deps)) {
    const w = await getWallet(deps.db, user.id, chain);
    if (w) {
      const amount = money(await adapter.getBalance(w.address), chain, deps.network);
      lines.push(`${namesItsCoin(amount) ? amount : `${amount} USDC`} on ${chainLabel(chain)}`);
    }
  }
  return lines.length ? replies.balance(lines) : replies.chainUnavailable(chainLabel(user.defaultChain));
}

async function receiveReply(deps: BotDeps, user: User): Promise<string> {
  const addresses: string[] = [];
  for (const [chain] of enabledChains(deps)) {
    const w = await getWallet(deps.db, user.id, chain);
    if (w) addresses.push(`${chainLabel(chain)}: ${w.address}`);
  }
  const handle = user.handle ?? displayName(user);
  return replies.receive(handle, `${deps.appUrl}/@${handle}`, addresses);
}

import { z } from "zod";
import { enabledChains } from "@/lib/bot/accounts";
import {
  announce,
  checkMoney,
  createMoneyIntent,
  createWithdrawIntent,
  findDuplicate,
  type MoneyError,
  type PreparedIntent,
  resolveCounterparty,
} from "@/lib/bot/money";
import { stockBalances } from "@/lib/bot/stocks";
import {
  confirmSplitText,
  createSplit,
  MAX_SPLIT_PEOPLE,
  type PreparedSplit,
  resolvePeople,
  splitChain,
  type SplitErrorCode,
} from "@/lib/bot/split";
import { text } from "@/lib/bot/text";
import { FEATURES, featuresOf } from "@/lib/settlement/capabilities";
import type { BotDeps } from "@/lib/bot/types";
import { CHAINS, chainLabel } from "@/lib/chains";
import { findContact } from "@/lib/contacts";
import type { Intent, User } from "@/lib/db/schema";
import {
  describe,
  displayName,
  findUserByHandle,
  findUserByPhone,
  getUserById,
  isClaimed,
  searchDirectory,
} from "@/lib/identity";
import { getIntent, intentsFor } from "@/lib/intents";
import { formatUsd, isUsdAmount } from "@/lib/money";
import { assetOf, money } from "@/lib/settlement/amounts";
import type { Network } from "@/lib/settlement/registry";
import type { MoneyKind } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { hasPasskey } from "@/lib/passkeys";
import { normalizePhone } from "@/lib/phone";
import { cleanAsk, payProfile } from "@/lib/views/pay";
import { buildPaymentView } from "@/lib/views/payment";
import { walletJson, walletView } from "@/lib/views/wallet";
import { formatAmount, formatShares, isShareAmount, stockForToken } from "@/lib/stocks";
import { getWallet } from "@/lib/wallets";
import type { Agent } from "./keys";

// ---------------------------------------------------------------------------------------------
// Inputs. These schemas are what tools/list advertises and what tools/call validates against.
// ---------------------------------------------------------------------------------------------

const amountUsd = z
  .string()
  .trim()
  .refine(isUsdAmount, 'Use a plain dollar amount like "10" or "2.50" (at most 2 decimals).')
  .describe('US dollar amount as a decimal string, e.g. "10" or "2.50". Settles as USDC.');

const person = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .describe('A phone number ("+15551234567"), a Dial handle ("@alex"), or a name from the owner\'s contacts ("alex").');

const note = z.string().trim().min(1).max(120).optional().describe("Short reason shown to both people, e.g. \"pizza\".");

const chain = z
  .enum(CHAINS)
  .optional()
  .describe("Chain to settle on. Defaults to the owner's default chain (Solana). Only switched-on chains work.");

const intentId = z
  .string()
  .trim()
  .regex(/^pi_[A-Za-z0-9_-]{8,32}$/, "Payment ids look like pi_…")
  .describe("The intentId returned by send_payment, request_payment, create_invoice or withdraw.");

const shares = z
  .string()
  .trim()
  .refine(isShareAmount, 'Use a plain share amount like "0.1" or "2" (at most 6 decimals).')
  .describe('How many shares of the stock token, as a decimal string, e.g. "0.1". Not dollars: testnet stock tokens have no price.');

const symbol = z
  .string()
  .trim()
  .regex(/^\$?[A-Za-z]{1,5}$/, "A ticker like TSLA")
  .transform((s) => s.replace(/^\$/, "").toUpperCase())
  .describe("The stock's ticker, e.g. TSLA. get_stocks lists the ones on Robinhood Chain.");

export const toolInputs = {
  whoami: z.object({}),
  get_balance: z.object({}),
  get_receive_address: z.object({}),
  resolve_recipient: z.object({ to: person }),
  send_payment: z.object({
    to: person,
    amountUsd,
    note,
    chain,
    private: z
      .boolean()
      .optional()
      .describe(
        "true: a private send, shielded on Zcash whatever the default chain. The amount and who paid whom stay off the public chain and public receipts. Fails if Zcash isn't switched on.",
      ),
  }),
  request_payment: z.object({ from: person, amountUsd, note, chain }),
  create_invoice: z.object({ to: person, amountUsd, note, chain }),
  withdraw: z.object({
    amountUsd: z.union([z.literal("all"), amountUsd]).describe('Dollar amount, or "all" for the whole balance.'),
    address: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .describe(
        "A wallet address the owner controls on that chain, or an ENS name (name.eth) or Basename (name.base.eth; name.basetest.eth on testnet). A name is resolved once, now; the payment keeps that address. A Basename picks Base and any other .eth name Ethereum, unless chain is set.",
      ),
    chain,
  }),
  get_payment: z.object({ intentId }),
  list_payments: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("How many to return, newest first. Default 10."),
  }),
  get_pay_link: z.object({
    handle: z
      .string()
      .trim()
      .regex(/^@?[A-Za-z0-9_]{1,32}$/, "A Dial handle like @alex")
      .optional()
      .describe("Whose pay link: a Dial @handle. Leave out for the owner's own link (to get paid)."),
    amountUsd: amountUsd.optional(),
    note,
  }),
  get_wallet: z.object({}),
  send_stock: z.object({ to: person, shares, symbol, note }),
  get_stocks: z.object({}),
  split_payment: z.object({
    amountUsd,
    people: z
      .array(person)
      .min(1)
      .max(MAX_SPLIT_PEOPLE)
      .describe("Who shares the amount: phone numbers, Dial @handles or contact names. Each person once."),
    includeMe: z
      .boolean()
      .optional()
      .describe("True when the owner takes a share too and pays everyone else's (\"split $30 with @a @b\"). Default false."),
    note,
    chain: z.enum(CHAINS).optional().describe("Leave out: splits run on a chain that settles them as one transaction (Tempo). A chain that can't is refused."),
  }),
  list_chain_features: z.object({}),
} as const;

export type ToolName = keyof typeof toolInputs;
type ToolInput<T extends ToolName> = z.infer<(typeof toolInputs)[T]>;

/** Tools that create a PaymentIntent and text someone; they share a tighter rate limit. */
export const MONEY_TOOLS: ReadonlySet<ToolName> = new Set([
  "send_payment",
  "request_payment",
  "create_invoice",
  "withdraw",
  "split_payment",
  "send_stock",
]);

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

type ToolError = {
  error: MoneyError["code"] | SplitErrorCode | "ambiguous_recipient" | "invalid_input" | "not_found" | "rate_limited" | "unavailable";
  message: string;
};
export type ToolResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: ToolError };

const ok = (data: Record<string, unknown>): ToolResult => ({ ok: true, data });
const err = (error: ToolError["error"], message: string): ToolResult => ({ ok: false, error: { error, message } });

/** "$12.50" → "12.50": plain decimals for machines. */
const usd = (base: bigint) => formatUsd(base).slice(1);

/** A payment's amount for machines: dollars and what the chain settles in, or shares and the stock's ticker (no dollar value). */
function amountOut(i: Intent, network: Network): { amountUsd: string | null; shares?: string; asset: string } {
  const stock = stockForToken(i.chain, i.token);
  return stock
    ? { amountUsd: null, shares: formatShares(i.amount), asset: stock.symbol }
    : { amountUsd: usd(i.amount), asset: assetOf(i.chain, network) };
}

export type AgentPaymentStatus =
  | "awaiting_approval"
  | "expired"
  | "settling"
  | "escrowed"
  | "settled"
  | "refunded"
  | "failed"
  | "declined";

function machineStatus(i: Intent, now: Date): AgentPaymentStatus {
  if (i.status === "pending") return i.expiresAt > now ? "awaiting_approval" : "expired";
  return i.status;
}

/** Who has to approve: the payer. "you" when that's the account owner. */
function approverOf(i: Intent, owner: User, payer: User | null): string {
  if (i.senderId === owner.id) return "you";
  return payer ? describe(payer) : "the payer";
}

async function paymentOut(deps: BotDeps, owner: User, i: Intent): Promise<Record<string, unknown>> {
  const now = deps.now();
  const view = await buildPaymentView(deps.db, i, now, { network: deps.network, audience: "party" });
  const payer = i.senderId === owner.id ? owner : await getUserById(deps.db, i.senderId);
  const status = machineStatus(i, now);
  return {
    intentId: i.id,
    kind: i.kind,
    status,
    statusLabel: view.status.label,
    ...amountOut(i, deps.network),
    shielded: i.private,
    from: view.from,
    // One leg of a split: who this leg pays. The view's "to" names the whole split.
    to: view.split?.legs.find((l) => l.id === i.id)?.to ?? view.to,
    chain: i.chain,
    note: i.note,
    approver: approverOf(i, owner, payer),
    approveUrl: `${deps.appUrl}/a/${i.id}`,
    approveBy: status === "awaiting_approval" ? i.expiresAt.toISOString() : null,
    createdAt: i.createdAt.toISOString(),
    settledAt: i.settledAt?.toISOString() ?? null,
    txHash: i.txHash,
    explorerUrl: i.explorerUrl,
    releaseTxHash: i.releaseTxHash,
    releaseExplorerUrl: i.releaseExplorerUrl,
    splitId: i.splitId,
  };
}

async function created(deps: BotDeps, agent: Agent, p: PreparedIntent): Promise<ToolResult> {
  const { user } = agent;
  const ownerText = await announce(deps, user, p);
  const ownerTexted = await text(deps, user.phone, replies.fromAgent(agent.key.label, ownerText));
  const i = p.intent;
  const payerIsOwner = i.senderId === user.id;
  const paused = "The owner has paused texts from Dial (STOP), so no code went out: they can approve at approveUrl with their passkey, or text START first.";
  return ok({
    intentId: i.id,
    status: "awaiting_approval",
    approveUrl: p.approveUrl,
    approver: payerIsOwner ? "you" : describe(p.counterparty),
    approveBy: i.expiresAt.toISOString(),
    kind: i.kind,
    ...amountOut(i, deps.network),
    chain: i.chain,
    ...(i.kind === "withdraw" ? { toAddress: i.recipientAddress, toName: i.recipientName } : {}),
    message: payerIsOwner && !ownerTexted
      ? paused
      : payerIsOwner
      ? `Texted the owner to approve ${formatAmount(i, deps.network)}. Nothing moves until they reply with the code or use their passkey. Poll get_payment for the result.`
      : `Texted ${describe(p.counterparty)} to pay ${formatAmount(i, deps.network)}. They approve or decline from their phone. Poll get_payment for the result.`,
  });
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

async function whoami(deps: BotDeps, agent: Agent): Promise<ToolResult> {
  const { user, key } = agent;
  return ok({
    handle: user.handle,
    phone: displayName({ handle: null, phone: user.phone }),
    defaultChain: user.defaultChain,
    chains: enabledChains(deps).map(([c]) => c),
    passkey: await hasPasskey(deps.db, user.id),
    limits: {
      perPaymentUsd: usd(deps.perTxCap),
      perDayUsd: usd(deps.perDayCap),
      passkeyRequiredAboveUsd: usd(deps.passkeyThreshold),
    },
    agent: { keyId: key.id, label: key.label, connectedAt: key.createdAt.toISOString() },
    approvals: "Every payment is approved by a human: the payer replies to a texted code or uses their passkey.",
  });
}

async function getBalance(deps: BotDeps, agent: Agent): Promise<ToolResult> {
  const balances: Array<Record<string, string>> = [];
  let total = 0n;
  for (const [c, adapter] of enabledChains(deps)) {
    const w = await getWallet(deps.db, agent.user.id, c);
    if (!w) continue;
    const amount = await adapter.getBalance(w.address);
    const asset = assetOf(c, deps.network);
    // Testnet ZEC converts at a demo rate, so it's listed but not added to the dollar total.
    if (asset === "USDC") total += amount;
    balances.push({ chain: c, network: chainLabel(c), amountUsd: usd(amount), asset, display: money(amount, c, deps.network) });
  }
  return ok({ balances, totalUsd: usd(total) });
}

async function getReceiveAddress(deps: BotDeps, agent: Agent): Promise<ToolResult> {
  const { user } = agent;
  const handle = user.handle ?? displayName(user);
  const addresses: Array<Record<string, string>> = [];
  for (const [c] of enabledChains(deps)) {
    const w = await getWallet(deps.db, user.id, c);
    if (w) addresses.push({ chain: c, network: chainLabel(c), address: w.address, asset: assetOf(c, deps.network) });
  }
  return ok({ handle, byText: `Anyone can text the Dial operator "send ${handle} $5".`, addresses });
}

const notFound = (raw: string) =>
  `No contact or Dial user matches "${raw}". Use their phone number (e.g. +15551234567) or Dial @handle.`;
const ambiguous = (raw: string, users: User[]) =>
  `"${raw}" matches ${users.map(describe).join(", ")}. Ask which one and pass their @handle.`;

async function resolveRecipient(deps: BotDeps, agent: Agent, input: ToolInput<"resolve_recipient">): Promise<ToolResult> {
  const raw = input.to;
  const escrowNote = "Not on Dial yet: a payment waits in escrow until they claim it by text, or comes back after it expires.";
  if (raw.startsWith("@")) {
    const u = await findUserByHandle(deps.db, raw.slice(1).toLowerCase());
    if (!u) return err("unknown_handle", replies.unknownHandle(raw));
    return ok({ found: true, via: "handle", name: describe(u), onDial: true });
  }
  const phone = normalizePhone(raw);
  const contact = phone ? null : await findContact(deps.db, agent.user.id, raw);
  const target = phone ?? contact?.phone ?? null;
  if (!target) {
    const exact = await findUserByHandle(deps.db, raw.toLowerCase());
    const matches = exact ? [exact] : await searchDirectory(deps.db, raw, 6);
    const others = matches.filter((u) => u.id !== agent.user.id).slice(0, 5);
    const [only] = others;
    if (others.length === 1 && only) return ok({ found: true, via: "directory", name: describe(only), onDial: true });
    if (others.length > 1) return err("ambiguous_recipient", ambiguous(raw, others));
    return err("unknown_recipient", notFound(raw));
  }
  if (target === agent.user.phone) return err("self", replies.selfSend());
  const u = await findUserByPhone(deps.db, target);
  const onDial = u !== null && isClaimed(u);
  return ok({
    found: true,
    via: phone ? "phone" : "contact",
    name: onDial ? describe(u) : contact ? contact.name : displayName({ handle: null, phone: target }),
    onDial,
    ...(onDial ? {} : { note: escrowNote }),
  });
}

async function moneyTool(
  deps: BotDeps,
  agent: Agent,
  kind: MoneyKind,
  input: { counterparty: string; amountUsd: string; note?: string; chain?: (typeof CHAINS)[number]; private?: boolean; asset?: string },
): Promise<ToolResult> {
  const { user } = agent;
  const { private: shielded, ...rest } = input;
  const cmd = { kind, ...rest, ...(shielded && kind === "send" ? { private: true as const } : {}) };
  const checked = checkMoney(deps, user, cmd);
  if (!checked.ok) return err(checked.error.code, checked.error.message);
  const resolved = await resolveCounterparty(deps, user, input.counterparty);
  if ("error" in resolved) return err("unknown_handle", resolved.error);
  if ("choose" in resolved) return err("ambiguous_recipient", ambiguous(input.counterparty, resolved.choose));
  if ("askFor" in resolved) return err("unknown_recipient", notFound(resolved.askFor));
  const other = resolved.user;
  if (other.id === user.id) return err("self", replies.selfSend());
  const dup = await findDuplicate(deps, user, other, kind, checked.amount, checked.chain, checked.token);
  if (dup && "pending" in dup) {
    return err(
      "duplicate",
      `The same ${kind} is already waiting for approval as ${dup.pending.id}. Poll get_payment instead of asking again.`,
    );
  }
  if (dup) return err("duplicate", `The same payment to ${describe(other)} went out minutes ago (${dup.justSent.id}). Check get_payment.`);
  const r = await createMoneyIntent(deps, user, cmd, other);
  return r.ok ? created(deps, agent, r.prepared) : err(r.error.code, r.error.message);
}

async function getStocks(deps: BotDeps, agent: Agent): Promise<ToolResult> {
  const chains = await stockBalances(deps, agent.user);
  if (chains.length === 0) return err("chain_unavailable", "No enabled chain carries assets like stock tokens right now.");
  return ok({
    chains: chains.map((b) => ({ chain: b.chain, network: b.network, address: b.address, holdings: b.holdings, sendable: b.symbols })),
    prices: null,
    note: "Testnet stock tokens have no price feed, so there are no dollar values. Send them by share count with send_stock.",
  });
}

async function splitCreated(deps: BotDeps, agent: Agent, s: PreparedSplit): Promise<ToolResult> {
  const { user } = agent;
  const ownerTexted = await text(deps, user.phone, replies.fromAgent(agent.key.label, confirmSplitText(s)));
  const [first] = s.legs;
  const pays = s.legs.reduce((a, l) => a + l.intent.amount, 0n);
  return ok({
    splitId: s.splitId,
    status: "awaiting_approval",
    approveUrl: s.approveUrl,
    approver: "you",
    approveBy: first?.intent.expiresAt.toISOString() ?? null,
    amountUsd: usd(s.total),
    paysUsd: usd(pays),
    ownShareUsd: s.mine === null ? null : usd(s.mine),
    asset: "USDC",
    chain: s.chain,
    legs: s.legs.map((l) => ({ intentId: l.intent.id, to: describe(l.person), amountUsd: usd(l.intent.amount), onDial: isClaimed(l.person) })),
    message: ownerTexted
      ? `Texted the owner one code for the whole split (${formatUsd(pays)}). Nothing moves until they approve; then every share settles in one transaction, or none do. Poll get_payment on any leg.`
      : "The owner has paused texts from Dial (STOP), so no code went out: they can approve at approveUrl with their passkey, or text START first.",
  });
}

async function splitPayment(deps: BotDeps, agent: Agent, input: ToolInput<"split_payment">): Promise<ToolResult> {
  const { user } = agent;
  // Checked before anyone is looked up, so a split that can't run never creates accounts.
  const picked = splitChain(deps, user, input.chain);
  if (!picked.ok && picked.error.code === "split_chain" && input.chain) {
    return err("split_chain", `Splits settle in one transaction, which ${chainLabel(input.chain)} can't do. Leave chain out to use one that can (see list_chain_features).`);
  }
  if (!picked.ok) return err(picked.error.code, picked.error.message);
  const resolved = await resolvePeople(deps, user, input.people);
  if (!resolved.ok) return err(resolved.error.code, resolved.error.message);
  const cmd = {
    kind: "split" as const,
    amountUsd: input.amountUsd,
    people: input.people,
    includeMe: input.includeMe ?? false,
    note: input.note,
    chain: picked.chain,
  };
  const r = await createSplit(deps, user, cmd, resolved.people);
  return r.ok ? splitCreated(deps, agent, r.split) : err(r.error.code, r.error.message);
}

async function withdraw(deps: BotDeps, agent: Agent, input: ToolInput<"withdraw">): Promise<ToolResult> {
  const r = await createWithdrawIntent(deps, agent.user, { kind: "withdraw", ...input });
  return r.ok ? created(deps, agent, r.prepared) : err(r.error.code, r.error.message);
}

function canSee(i: Intent, userId: string): boolean {
  return i.senderId === userId || i.recipientId === userId || i.createdBy === userId;
}

async function getPayment(deps: BotDeps, agent: Agent, input: ToolInput<"get_payment">): Promise<ToolResult> {
  const i = await getIntent(deps.db, input.intentId);
  if (!i || !canSee(i, agent.user.id)) return err("not_found", `No payment ${input.intentId} on this account.`);
  return ok(await paymentOut(deps, agent.user, i));
}

async function listPayments(deps: BotDeps, agent: Agent, input: ToolInput<"list_payments">): Promise<ToolResult> {
  const rows = await intentsFor(deps.db, agent.user.id, input.limit ?? 10);
  const payments: Array<Record<string, unknown>> = [];
  for (const i of rows) payments.push(await paymentOut(deps, agent.user, i));
  return ok({ payments });
}

async function getPayLink(deps: BotDeps, agent: Agent, input: ToolInput<"get_pay_link">): Promise<ToolResult> {
  const handle = input.handle?.replace(/^@/, "").toLowerCase();
  const target = handle ? await findUserByHandle(deps.db, handle) : agent.user;
  if (!target || !isClaimed(target) || !target.handle) {
    return err(
      "not_found",
      handle ? `No Dial user @${handle}. To pay a phone number, use send_payment.` : "This account has no Dial handle, so it has no pay link.",
    );
  }
  return ok(await payProfile(deps, target, cleanAsk(deps, { amount: input.amountUsd, note: input.note })));
}

async function walletTool(deps: BotDeps, agent: Agent): Promise<ToolResult> {
  return ok(walletJson(await walletView(deps, agent.user)));
}

/** Every enabled chain with the chain-native modules it carries, so an agent can see what each chain can do. */
async function listChainFeatures(deps: BotDeps): Promise<ToolResult> {
  const chains = enabledChains(deps).map(([chain, adapter]) => ({
    chain,
    name: chainLabel(chain),
    features: featuresOf(adapter).map((id) => ({ id, ...FEATURES[id] })),
  }));
  return ok({ chains });
}

function withInput<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  run: (input: z.output<S>) => Promise<ToolResult>,
): Promise<ToolResult> {
  const p = schema.safeParse(raw ?? {});
  return p.success ? run(p.data) : Promise.resolve(err("invalid_input", z.prettifyError(p.error)));
}

/** Validates the arguments and runs one tool for the agent's account. */
export function runTool(deps: BotDeps, agent: Agent, name: ToolName, raw: unknown): Promise<ToolResult> {
  switch (name) {
    case "whoami":
      return whoami(deps, agent);
    case "get_balance":
      return getBalance(deps, agent);
    case "get_receive_address":
      return getReceiveAddress(deps, agent);
    case "resolve_recipient":
      return withInput(toolInputs.resolve_recipient, raw, (i) => resolveRecipient(deps, agent, i));
    case "send_payment":
      return withInput(toolInputs.send_payment, raw, ({ to, ...i }) =>
        moneyTool(deps, agent, "send", { ...i, counterparty: to }),
      );
    case "request_payment":
      return withInput(toolInputs.request_payment, raw, ({ from, ...i }) =>
        moneyTool(deps, agent, "request", { ...i, counterparty: from }),
      );
    case "create_invoice":
      return withInput(toolInputs.create_invoice, raw, ({ to, ...i }) =>
        moneyTool(deps, agent, "invoice", { ...i, counterparty: to }),
      );
    case "withdraw":
      return withInput(toolInputs.withdraw, raw, (i) => withdraw(deps, agent, i));
    case "get_payment":
      return withInput(toolInputs.get_payment, raw, (i) => getPayment(deps, agent, i));
    case "list_payments":
      return withInput(toolInputs.list_payments, raw, (i) => listPayments(deps, agent, i));
    case "get_pay_link":
      return withInput(toolInputs.get_pay_link, raw, (i) => getPayLink(deps, agent, i));
    case "get_wallet":
      return walletTool(deps, agent);
    case "send_stock":
      return withInput(toolInputs.send_stock, raw, ({ to, shares: amount, symbol: asset, note: n }) =>
        moneyTool(deps, agent, "send", { counterparty: to, amountUsd: amount, asset, ...(n ? { note: n } : {}) }),
      );
    case "get_stocks":
      return getStocks(deps, agent);
    case "split_payment":
      return withInput(toolInputs.split_payment, raw, (i) => splitPayment(deps, agent, i));
    case "list_chain_features":
      return listChainFeatures(deps);
  }
}

export const toolDescriptions: Record<ToolName, { title: string; description: string }> = {
  whoami: {
    title: "Who am I",
    description: "The Dial account this key acts for: handle, enabled chains, limits, and whether it has a passkey.",
  },
  get_balance: { title: "Balance", description: "USDC balance on each enabled chain." },
  get_receive_address: {
    title: "Receive address",
    description: "How others can pay this account: its Dial handle (pay by text) and a USDC address per chain.",
  },
  resolve_recipient: {
    title: "Resolve recipient",
    description:
      "Check who a phone number, @handle or contact name points to before paying them, and whether they're on Dial yet. Read-only.",
  },
  send_payment: {
    title: "Send payment",
    description:
      "Start a USDC payment from the owner to someone, or a private one shielded on Zcash with private: true. Creates a pending payment and texts the owner a one-time code and approval link. Nothing moves until the owner approves; you cannot approve. Returns intentId and approveUrl; poll get_payment.",
  },
  request_payment: {
    title: "Request payment",
    description:
      "Ask someone to pay the owner. Texts that person a code and link to pay or decline, and texts the owner a heads-up. Returns intentId; poll get_payment.",
  },
  create_invoice: {
    title: "Create invoice",
    description:
      "Bill someone on the owner's behalf. Like request_payment, but the link renders as an invoice. Returns intentId and the invoice link.",
  },
  withdraw: {
    title: "Withdraw",
    description:
      "Move the owner's USDC to an outside address, ENS name or Basename on the same chain. Texts the owner to approve, like send_payment. Returns toAddress, the address the payment will go to.",
  },
  get_payment: {
    title: "Get payment",
    description:
      "Status of one payment: awaiting_approval, expired, settling, escrowed (waiting for the recipient to claim), settled, refunded, failed or declined, with the on-chain receipt once settled.",
  },
  list_payments: { title: "List payments", description: "Recent payments, requests and invoices on this account, newest first." },
  get_pay_link: {
    title: "Pay link",
    description:
      "A shareable pay page (crypto Zelle) for the owner or any Dial @handle, optionally for a set amount and note. Returns the page URL, the text to send the operator, and a wallet link per chain (Solana Pay, EIP-681). Share the owner's link to get paid; read someone else's to pay them. Read-only.",
  },
  send_stock: {
    title: "Send stock token",
    description:
      "Gift tokenized stock (e.g. 0.1 TSLA) from the owner's Robinhood Chain wallet to someone, by share count. Same approval as send_payment: the owner gets a texted code and link, and nothing moves until they approve. Someone not on Dial yet can claim it by text. Dollar amounts aren't supported: testnet stock tokens have no price. Returns intentId; poll get_payment.",
  },
  get_stocks: {
    title: "Stock tokens",
    description:
      "The owner's stock token balances on Robinhood Chain (shares, no dollar values on testnet), their Robinhood Chain address, and which tickers can be sent. Read-only.",
  },
  split_payment: {
    title: "Split payment",
    description:
      "Split an amount between people, to the cent (any leftover cent goes to the first person). With includeMe the owner takes a share and pays everyone else's. Up to 10 people. Runs on a chain with batched transactions (Tempo, see list_chain_features): the owner approves once with one texted code, then every share settles in one transaction with each payment id as its memo, or none do. People not on Dial yet get their share held for them to claim. Returns splitId and an intentId per person; poll get_payment.",
  },
  get_wallet: {
    title: "Wallet",
    description:
      "The owner's wallet: balance and deposit address per chain, their pay link, recent activity and connected agents. Read-only.",
  },
  list_chain_features: {
    title: "Chain features",
    description:
      "Each enabled chain and the chain-native features it carries (escrow, names, split payments, wallet pay links, private sends, venue transfers, assets), in plain words. Read-only.",
  },
};

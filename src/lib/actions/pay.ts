import { and, eq, gt, isNull } from "drizzle-orm";
import { getAddressDecoder } from "@solana/kit";
import { ensureWallet } from "@/lib/bot/accounts";
import type { BotDeps } from "@/lib/bot/types";
import type { Chain } from "@/lib/chains";
import { actionPayments, type User } from "@/lib/db/schema";
import { findUserByHandle, isClaimed } from "@/lib/identity";
import { newId } from "@/lib/ids";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import { payActionUrl } from "@/lib/pay-links";
import { chainWith, type PaymentActions } from "@/lib/settlement/capabilities";
import { REGISTRY } from "@/lib/settlement/registry";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { cleanAsk } from "@/lib/views/pay";
import type { ActionGetResponse, LinkedAction } from "./spec";

/** How long the cron keeps looking for a payment after its transaction was handed out. */
const REFERENCE_TTL_MS = 30 * 60_000;
/** Unpaid transactions one handle may have out at once: each is a row and a lookup every minute. */
export const MAX_OPEN_PER_HANDLE = 30;
const PRESETS = ["1", "5", "10"];

export type PayActionDeps = Pick<BotDeps, "db" | "adapters" | "walletKey" | "perTxCap" | "appUrl" | "now" | "network">;
export type ActionsChain = { chain: Chain; adapter: SettlementAdapter; module: PaymentActions };

/**
 * The chain pay-link actions run on: the one carrying the `actions` module, Solana first since the
 * Actions spec is Solana's. Null when no enabled chain carries it.
 */
export function actionsChain(adapters: BotDeps["adapters"]): ActionsChain | null {
  return chainWith(adapters, "actions", "solana");
}

/** A claimed Dial user with this handle, or null. */
export async function actionPayee(db: BotDeps["db"], handle: string): Promise<User | null> {
  const user = await findUserByHandle(db, handle);
  return user?.handle && isClaimed(user) ? user : null;
}

/**
 * The GET body: who is being paid, $1/$5/$10 buttons and a custom amount up to the per-payment cap. A
 * link that already asks for an amount gets one button for exactly that.
 */
export function payActionMetadata(
  deps: Pick<PayActionDeps, "appUrl" | "perTxCap" | "network">,
  chain: Chain,
  user: Pick<User, "handle" | "name">,
  raw: { amount?: string | null; note?: string | null },
): ActionGetResponse {
  const handle = user.handle ?? "";
  const ask = cleanAsk(deps, raw);
  const who = user.name && user.name !== `@${handle}` ? `${user.name} (@${handle})` : `@${handle}`;
  const network = REGISTRY[chain][deps.network]?.network ?? chain;
  const test = deps.network === "testnet" ? "test " : "";
  const cap = Number(formatUsd(deps.perTxCap).slice(1));
  const href = (amount: string) => payActionUrl(deps.appUrl, handle, { amountUsd: amount, ...(ask.note ? { note: ask.note } : {}) });
  const actions: LinkedAction[] = ask.amountUsd
    ? [{ type: "transaction", label: `Pay $${ask.amountUsd}`, href: href(ask.amountUsd) }]
    : [
        ...PRESETS.filter((p) => usdToBaseUnits(p) <= deps.perTxCap).map(
          (p): LinkedAction => ({ type: "transaction", label: `$${p}`, href: href(p) }),
        ),
        {
          type: "transaction",
          label: "Pay",
          href: href("{amount}").replace(encodeURIComponent("{amount}"), "{amount}"),
          parameters: [{ type: "number", name: "amount", label: `Amount in USD, up to $${cap}`, required: true, min: 0.01, max: cap }],
        },
      ];
  return {
    type: "action",
    icon: `${deps.appUrl}/pay/${handle}/card${new URL(payActionUrl(deps.appUrl, handle, ask)).search}`,
    title: `Pay ${who}${ask.amountUsd ? ` $${ask.amountUsd}` : ""}${ask.note ? ` for ${ask.note}` : ""}`,
    description: `Send ${who} ${test}USDC on ${network} from any wallet. It lands in their Dial wallet and they get a text receipt. Powered by Dial.Work.`,
    label: ask.amountUsd ? `Pay $${ask.amountUsd}` : "Pay",
    links: { actions },
  };
}

/** A fresh reference key: 32 random bytes. It never signs, so it needn't be on the curve. */
export function newReference(): string {
  return getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
}

export type PreparedPayment =
  | { ok: true; transaction: string; message: string; id: string; reference: string }
  | { ok: false; status: number; message: string };

/**
 * POST: checks the payer and amount, stores the reference with what is expected, and builds the
 * transaction. Nothing moves until the payer signs and sends it; the cron records it once it lands.
 */
export async function preparePayment(
  deps: PayActionDeps,
  on: ActionsChain,
  input: { handle: string; account: unknown; amount?: string | null; note?: string | null },
): Promise<PreparedPayment> {
  const cap = formatUsd(deps.perTxCap);
  if (typeof input.account !== "string" || !on.adapter.isValidAddress(input.account)) {
    return { ok: false, status: 400, message: "That isn't a wallet address." };
  }
  const ask = cleanAsk(deps, { amount: input.amount, note: input.note });
  if (!ask.amountUsd) return { ok: false, status: 400, message: `Amounts can be from $0.01 to ${cap}.` };
  const amount = usdToBaseUnits(ask.amountUsd);

  const user = await actionPayee(deps.db, input.handle);
  if (!user?.handle) return { ok: false, status: 404, message: "No Dial user with that handle." };
  const wallet = await ensureWallet(deps, user.id, on.chain, on.adapter);
  if (wallet.address === input.account) return { ok: false, status: 400, message: `That is @${user.handle}'s own Dial wallet.` };

  const now = deps.now();
  const open = await deps.db.$count(
    actionPayments,
    and(eq(actionPayments.recipientId, user.id), isNull(actionPayments.signature), gt(actionPayments.expiresAt, now)),
  );
  if (open >= MAX_OPEN_PER_HANDLE) {
    return { ok: false, status: 429, message: `Too many unpaid payments to @${user.handle} right now. Try again in a few minutes.` };
  }

  // A balance the RPC can't read doesn't block: the wallet's own simulation will catch a short one.
  const balance = await on.adapter.getBalance(input.account).catch(() => null);
  if (balance !== null && balance < amount) {
    const testnet = deps.network === "testnet";
    return {
      ok: false,
      status: 400,
      message: `This wallet has ${formatUsd(balance)} in ${testnet ? "test " : ""}USDC, not ${formatUsd(amount)}.${testnet ? " Get test USDC at faucet.circle.com." : ""}`,
    };
  }

  const id = newId("ap");
  const reference = newReference();
  const transaction = await on.module.buildPayment({ payer: input.account, recipient: wallet.address, amount, reference, memo: id });
  await deps.db.insert(actionPayments).values({
    id,
    reference,
    recipientId: user.id,
    chain: on.chain,
    recipientAddress: wallet.address,
    payerAddress: input.account,
    amount,
    note: ask.note ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFERENCE_TTL_MS),
  });
  return { ok: true, transaction, id, reference, message: `Pays ${formatUsd(amount)} USDC to @${user.handle}'s Dial wallet.` };
}

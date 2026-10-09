import { and, count, eq, gt, isNull } from "drizzle-orm";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  isAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { ensureWallet } from "@/lib/bot/accounts";
import type { BotDeps } from "@/lib/bot/types";
import { actionPayments, type User } from "@/lib/db/schema";
import { findUserByHandle, isClaimed } from "@/lib/identity";
import { newId } from "@/lib/ids";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import { payActionUrl } from "@/lib/pay-links";
import type { SolanaNetwork } from "@/lib/settlement/registry";
import { cleanAsk } from "@/lib/views/pay";
import type { ActionChainReader } from "./rpc";
import type { ActionGetResponse, LinkedAction } from "./spec";

const DECIMALS = 6;
/** How long the cron keeps looking for a payment after its transaction was handed out. */
export const REFERENCE_TTL_MS = 30 * 60_000;
/** Unpaid transactions one handle may have out at once: each is a row and a lookup every minute. */
export const MAX_OPEN_PER_HANDLE = 30;
const PRESETS = ["1", "5", "10"];

export type PayActionDeps = Pick<BotDeps, "db" | "adapters" | "walletKey" | "perTxCap" | "appUrl" | "now" | "network">;

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
  user: Pick<User, "handle" | "name">,
  raw: { amount?: string | null; note?: string | null },
  entry: Pick<SolanaNetwork, "network">,
): ActionGetResponse {
  const handle = user.handle ?? "";
  const ask = cleanAsk(deps, raw);
  const who = user.name && user.name !== `@${handle}` ? `${user.name} (@${handle})` : `@${handle}`;
  const forNote = ask.note ? ` for ${ask.note}` : "";
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
    title: `Pay ${who}${ask.amountUsd ? ` $${ask.amountUsd}` : ""}${forNote}`,
    description: `Send ${who} ${test}USDC on ${entry.network} from any Solana wallet. It lands in their Dial wallet and they get a text receipt. Powered by Dial.Work.`,
    label: ask.amountUsd ? `Pay $${ask.amountUsd}` : "Pay",
    links: { actions },
  };
}

/**
 * The unsigned transfer the payer's wallet signs: create the recipient's USDC account if it is missing
 * (the payer pays its rent), move the USDC with the reference as a read-only account so the payment
 * can be found by it, and a memo with the payment id. The payer is the fee payer and only signer.
 */
export async function buildPayTransaction(a: {
  payer: string;
  recipient: string;
  mint: string;
  amount: bigint;
  reference: string;
  memo: string;
  lifetime: { blockhash: string; lastValidBlockHeight: bigint };
}): Promise<string> {
  const payer = createNoopSigner(address(a.payer));
  const mint = address(a.mint);
  const recipient = address(a.recipient);
  const ata = async (owner: typeof recipient) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const [source, destination] = await Promise.all([ata(payer.address), ata(recipient)]);
  const transfer = getTransferCheckedInstruction({ source, mint, destination, authority: payer, amount: a.amount, decimals: DECIMALS });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: a.lifetime.blockhash as Blockhash, lastValidBlockHeight: a.lifetime.lastValidBlockHeight },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata: destination, owner: recipient, mint }),
          { ...transfer, accounts: [...transfer.accounts, { address: address(a.reference), role: AccountRole.READONLY }] },
          getAddMemoInstruction({ memo: a.memo }),
        ],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
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
  chain: { entry: SolanaNetwork; reader: ActionChainReader },
  input: { handle: string; account: unknown; amount?: string | null; note?: string | null },
): Promise<PreparedPayment> {
  const cap = formatUsd(deps.perTxCap);
  if (typeof input.account !== "string" || !isAddress(input.account)) {
    return { ok: false, status: 400, message: "That isn't a Solana wallet address." };
  }
  const ask = cleanAsk(deps, { amount: input.amount, note: input.note });
  if (!ask.amountUsd) return { ok: false, status: 400, message: `Amounts can be from $0.01 to ${cap}.` };
  const amount = usdToBaseUnits(ask.amountUsd);

  const user = await actionPayee(deps.db, input.handle);
  if (!user?.handle) return { ok: false, status: 404, message: "No Dial user with that handle." };
  const adapter = deps.adapters.solana;
  if (!adapter) return { ok: false, status: 503, message: "Solana payments are switched off right now." };
  const wallet = await ensureWallet(deps, user.id, "solana", adapter);
  if (wallet.address === input.account) return { ok: false, status: 400, message: `That is @${user.handle}'s own Dial wallet.` };

  const now = deps.now();
  const [open] = await deps.db
    .select({ n: count() })
    .from(actionPayments)
    .where(and(eq(actionPayments.recipientId, user.id), isNull(actionPayments.signature), gt(actionPayments.expiresAt, now)));
  if ((open?.n ?? 0) >= MAX_OPEN_PER_HANDLE) {
    return { ok: false, status: 429, message: `Too many unpaid payments to @${user.handle} right now. Try again in a few minutes.` };
  }

  const balance = await chain.reader.tokenBalance(input.account, chain.entry.mint);
  if (balance !== null && balance < amount) {
    const faucet = deps.network === "testnet" ? " Get test USDC at faucet.circle.com." : "";
    return {
      ok: false,
      status: 400,
      message: `This wallet has ${formatUsd(balance)} in ${deps.network === "testnet" ? "devnet " : ""}USDC, not ${formatUsd(amount)}.${faucet}`,
    };
  }

  const id = newId("ap");
  const reference = newReference();
  const transaction = await buildPayTransaction({
    payer: input.account,
    recipient: wallet.address,
    mint: chain.entry.mint,
    amount,
    reference,
    memo: id,
    lifetime: await chain.reader.latestBlockhash(),
  });
  await deps.db.insert(actionPayments).values({
    id,
    reference,
    recipientId: user.id,
    chain: "solana",
    recipientAddress: wallet.address,
    payerAddress: input.account,
    amount,
    note: ask.note ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFERENCE_TTL_MS),
  });
  return { ok: true, transaction, id, reference, message: `Pays ${formatUsd(amount)} USDC to @${user.handle}'s Dial wallet.` };
}

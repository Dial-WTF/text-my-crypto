import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
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
import type { PaymentActions } from "./capabilities";
import { withRateLimitRetry as rl } from "./retry";

const DECIMALS = 6;

/** A token balance row from getTransaction's meta (encoding "json"). */
type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

/** The parts of a confirmed transaction that say who paid whom. */
export type ConfirmedTx = { err: unknown; feePayer: string; pre: readonly TokenBalance[]; post: readonly TokenBalance[] };

/**
 * The unsigned transfer a payer's wallet signs: create the recipient's token account if it is missing
 * (the payer pays its rent), move the stablecoin with the reference as a read-only account so the
 * payment can be found by it, and a memo with the payment id. The payer is the fee payer and only signer.
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
  const ata = async (owner: typeof recipient) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
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

/**
 * What a confirmed transaction paid `recipient` in `mint`: its token accounts' gain, and the wallet whose
 * balance of that mint fell the most (else the fee payer). Null when it failed or paid them nothing.
 */
export function paidTo(tx: ConfirmedTx, mint: string, recipient: string): { received: bigint; from: string } | null {
  if (tx.err) return null;
  const deltas = new Map<number, { owner?: string; delta: bigint }>();
  for (const [rows, sign] of [
    [tx.pre, -1n],
    [tx.post, 1n],
  ] as const) {
    for (const b of rows) {
      if (b.mint !== mint) continue;
      const d = deltas.get(b.accountIndex) ?? { owner: b.owner, delta: 0n };
      d.owner ??= b.owner;
      d.delta += sign * BigInt(b.uiTokenAmount.amount);
      deltas.set(b.accountIndex, d);
    }
  }
  let received = 0n;
  let from: { owner?: string; delta: bigint } | null = null;
  for (const d of deltas.values()) {
    if (d.owner === recipient) received += d.delta;
    else if (d.delta < 0n && (!from || d.delta < from.delta)) from = d;
  }
  return received > 0n ? { received, from: from?.owner ?? tx.feePayer } : null;
}

/** Solana Actions on one network: pay links any Solana wallet can sign, found again by reference key. */
export function createSolanaActions(cfg: {
  rpcUrl: string;
  mint: string;
  caip2: string;
  explorerTx: (sig: string) => string;
}): PaymentActions {
  const rpc = createSolanaRpc(cfg.rpcUrl);
  return {
    blockchainId: cfg.caip2,
    async buildPayment(args) {
      const { value } = await rl(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
      return buildPayTransaction({ ...args, mint: cfg.mint, lifetime: value });
    },
    async findByReference(reference, recipient) {
      const sigs = await rl(() => rpc.getSignaturesForAddress(address(reference), { limit: 10, commitment: "confirmed" }).send());
      const found = [];
      for (const { signature, err } of [...sigs].reverse()) {
        if (err) continue;
        const tx = await rl(() =>
          rpc.getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send(),
        );
        if (!tx?.meta) continue;
        const paid = paidTo(
          {
            err: tx.meta.err,
            feePayer: String(tx.transaction.message.accountKeys[0]),
            pre: tx.meta.preTokenBalances ?? [],
            post: tx.meta.postTokenBalances ?? [],
          },
          cfg.mint,
          recipient,
        );
        if (paid) found.push({ txHash: signature, explorerUrl: cfg.explorerTx(signature), payer: paid.from, amount: paid.received });
      }
      return found;
    },
  };
}

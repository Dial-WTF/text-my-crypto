import { address, createSolanaRpc, getBase64Encoder, type Signature } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { withRateLimitRetry as rl } from "@/lib/settlement/retry";

/** A token balance row from getTransaction's meta (encoding "json"). */
export type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };

/** The parts of a confirmed transaction the reference matcher reads. */
export type ConfirmedTx = {
  err: unknown;
  /** The fee payer: the first account key. */
  feePayer: string;
  pre: TokenBalance[];
  post: TokenBalance[];
};

/** What the pay action and its reference matcher ask of the chain. Tests hand in fakes. */
export type ActionChainReader = {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** The owner's balance of `mint` in base units: 0 when they have no token account, null when the RPC didn't say. */
  tokenBalance(owner: string, mint: string): Promise<bigint | null>;
  /** Signatures of transactions that touched this reference, newest first. */
  signatures(reference: string): Promise<Array<{ signature: string; err: unknown }>>;
  transaction(signature: string): Promise<ConfirmedTx | null>;
};

/** The reader over a real Solana RPC, at "confirmed" commitment. */
export function solanaChainReader(rpcUrl: string): ActionChainReader {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async latestBlockhash() {
      const { value } = await rl(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async tokenBalance(owner, mint) {
      try {
        const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const { value } = await rl(() => rpc.getAccountInfo(ata, { encoding: "base64", commitment: "confirmed" }).send());
        if (!value) return 0n;
        // An SPL token account: mint (32 bytes), owner (32), then the amount as a little-endian u64.
        const data = getBase64Encoder().encode(value.data[0]);
        return data.length >= 72 ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : null;
      } catch {
        return null;
      }
    },
    async signatures(reference) {
      const rows = await rl(() => rpc.getSignaturesForAddress(address(reference), { limit: 10, commitment: "confirmed" }).send());
      return rows.map((r) => ({ signature: r.signature, err: r.err }));
    },
    async transaction(signature) {
      const tx = await rl(() =>
        rpc
          .getTransaction(signature as Signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
          .send(),
      );
      if (!tx?.meta) return null;
      const balances = (rows: readonly unknown[] | null | undefined) => (rows ?? []) as TokenBalance[];
      return {
        err: tx.meta.err,
        feePayer: String(tx.transaction.message.accountKeys[0]),
        pre: balances(tx.meta.preTokenBalances),
        post: balances(tx.meta.postTokenBalances),
      };
    },
  };
}

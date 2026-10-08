import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { SettlementAdapter, SettleResult } from "./types";

const DECIMALS = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function createSolanaAdapter(cfg: {
  rpcUrl: string;
  mint: string;
  treasurySeed: Uint8Array<ArrayBuffer>;
}): SettlementAdapter {
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const mint = address(cfg.mint);
  const treasury = createKeyPairSignerFromPrivateKeyBytes(cfg.treasurySeed);

  async function ataOf(owner: Address): Promise<Address> {
    const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return pda;
  }

  async function sendAndConfirm(instructions: Instruction[]): Promise<string> {
    const feePayer = await treasury;
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const sig = getSignatureFromTransaction(tx);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
    for (let i = 0; i < 40; i++) {
      const { value } = await rpc.getSignatureStatuses([sig]).send();
      const status = value[0];
      if (status?.err) throw new Error(`Solana tx ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return sig;
      await sleep(750);
    }
    throw new Error(`Solana tx ${sig} not confirmed in time`);
  }

  async function transfer(from: KeyPairSigner, to: Address, amount: bigint, memo: string): Promise<SettleResult> {
    const feePayer = await treasury;
    const [source, destination] = await Promise.all([ataOf(from.address), ataOf(to)]);
    const sig = await sendAndConfirm([
      getCreateAssociatedTokenIdempotentInstruction({ payer: feePayer, ata: destination, owner: to, mint }),
      getTransferCheckedInstruction({ source, mint, destination, authority: from, amount, decimals: DECIMALS }),
      getAddMemoInstruction({ memo }),
    ]);
    return { txHash: sig, explorerUrl: explorer(sig) };
  }

  return {
    chain: "solana",
    tokenId: cfg.mint,
    async createWallet() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const signer = await createKeyPairSignerFromPrivateKeyBytes(secret);
      return { address: signer.address, secret };
    },
    async getBalance(owner) {
      const ata = await ataOf(address(owner));
      const { value } = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
      if (!value) return 0n;
      const bal = await rpc.getTokenAccountBalance(ata).send();
      return BigInt(bal.value.amount);
    },
    async settle({ fromSecret, to, amount, memo }) {
      const from = await createKeyPairSignerFromPrivateKeyBytes(fromSecret);
      return transfer(from, address(to), amount, memo);
    },
    async fund(to, amount) {
      return transfer(await treasury, address(to), amount, "dial signup drip");
    },
  };
}

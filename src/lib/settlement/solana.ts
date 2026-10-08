import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
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
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { withRateLimitRetry as rl } from "./retry";
import type { SettlementAdapter, SettleResult } from "./types";

const DECIMALS = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSolanaAdapter(cfg: {
  rpcUrl: string;
  mint: string;
  explorerTx: (sig: string) => string;
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
    const { value: latest } = await rl(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const sig = getSignatureFromTransaction(tx);
    const wire = getBase64EncodedWireTransaction(tx);
    await rl(() => rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const { value } = await rl(() => rpc.getSignatureStatuses([sig]).send());
      const status = value[0];
      if (status?.err) throw new Error(`Solana tx ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return sig;
    }
    throw new Error(`Solana tx ${sig} not confirmed in time`);
  }

  async function transfer(
    from: KeyPairSigner,
    to: Address,
    amount: bigint,
    memo: string,
    closeSource = false,
  ): Promise<SettleResult> {
    const feePayer = await treasury;
    const [source, destination] = await Promise.all([ataOf(from.address), ataOf(to)]);
    const instructions: Instruction[] = [
      getCreateAssociatedTokenIdempotentInstruction({ payer: feePayer, ata: destination, owner: to, mint }),
      getTransferCheckedInstruction({ source, mint, destination, authority: from, amount, decimals: DECIMALS }),
      getAddMemoInstruction({ memo }),
    ];
    if (closeSource) {
      instructions.push(getCloseAccountInstruction({ account: source, destination: feePayer.address, owner: from }));
    }
    const sig = await sendAndConfirm(instructions);
    return { txHash: sig, explorerUrl: cfg.explorerTx(sig) };
  }

  return {
    chain: "solana",
    tokenId: cfg.mint,
    isValidAddress: (a) => isAddress(a),
    async createWallet() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const signer = await createKeyPairSignerFromPrivateKeyBytes(secret);
      return { address: signer.address, secret };
    },
    async getBalance(owner) {
      const ata = await ataOf(address(owner));
      const { value } = await rl(() => rpc.getAccountInfo(ata, { encoding: "base64" }).send());
      if (!value) return 0n;
      const bal = await rl(() => rpc.getTokenAccountBalance(ata).send());
      return BigInt(bal.value.amount);
    },
    async settle({ fromSecret, to, amount, memo, closeSource }) {
      const from = await createKeyPairSignerFromPrivateKeyBytes(fromSecret);
      return transfer(from, address(to), amount, memo, closeSource);
    },
    async fund(to, amount) {
      return transfer(await treasury, address(to), amount, "dial signup drip");
    },
  };
}

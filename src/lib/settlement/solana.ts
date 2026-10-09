import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
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
import {
  decodeEscrowAccount,
  type EscrowAccount,
  escrowEventsFromLogs,
  findEscrowAddress,
  findVaultAddress,
  getClaimInstruction,
  getCreateEscrowInstruction,
  getRefundInstruction,
  intentIdHash,
} from "./solana-escrow";
import type { EscrowProgram, SettlementAdapter, SettleResult } from "./types";

const DECIMALS = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSolanaAdapter(cfg: {
  rpcUrl: string;
  mint: string;
  explorerTx: (sig: string) => string;
  treasurySeed: Uint8Array<ArrayBuffer>;
  /** The dial_escrow program and the attestor key that signs claims. Absent: escrow stays server-held. */
  escrow?: { programId: string; attestorSeed: Uint8Array<ArrayBuffer> };
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

  function escrowProgram(e: { programId: string; attestorSeed: Uint8Array<ArrayBuffer> }): EscrowProgram {
    const programId = address(e.programId);
    const attestor = createKeyPairSignerFromPrivateKeyBytes(e.attestorSeed);
    const result = (sig: string): SettleResult => ({ txHash: sig, explorerUrl: cfg.explorerTx(sig) });

    async function pdas(intentId: string) {
      const hash = await intentIdHash(intentId);
      const escrow = await findEscrowAddress(programId, hash);
      return { hash, escrow, vault: await findVaultAddress(programId, escrow) };
    }

    async function read(escrow: Address): Promise<EscrowAccount | null> {
      const { value } = await rl(() => rpc.getAccountInfo(escrow, { encoding: "base64", commitment: "confirmed" }).send());
      return value ? decodeEscrowAccount(getBase64Encoder().encode(value.data[0])) : null;
    }

    /** The escrow is gone: find the transaction that closed it, and accept it only if it closed the way we wanted. */
    async function closedBy(escrow: Address, want: "EscrowClaimed" | "EscrowRefunded"): Promise<SettleResult> {
      const sigs = await rl(() => rpc.getSignaturesForAddress(escrow, { limit: 10, commitment: "confirmed" }).send());
      for (const { signature, err } of sigs) {
        if (err) continue;
        const tx = await rl(() =>
          rpc.getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send(),
        );
        const closing = escrowEventsFromLogs(tx?.meta?.logMessages ?? []).find((ev) => ev.escrow === escrow && ev.name !== "EscrowCreated");
        if (!closing) continue;
        if (closing.name === want) return result(signature);
        throw new Error(`Escrow ${escrow} was already ${closing.name === "EscrowClaimed" ? "claimed" : "refunded"} in ${signature}`);
      }
      throw new Error(`No escrow at ${escrow}`);
    }

    return {
      programId: e.programId,
      async vaultAddress(intentId) {
        return (await pdas(intentId)).vault;
      },
      async create({ fromSecret, intentId, amount, expiresAt }) {
        const [payer, sender, att] = await Promise.all([treasury, createKeyPairSignerFromPrivateKeyBytes(fromSecret), attestor]);
        const { hash, escrow, vault } = await pdas(intentId);
        const sig = await sendAndConfirm([
          getCreateEscrowInstruction({
            programId,
            payer,
            sender,
            senderToken: await ataOf(sender.address),
            mint,
            attestor: att.address,
            escrow,
            vault,
            intentIdHash: hash,
            amount,
            expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1000)),
          }),
          getAddMemoInstruction({ memo: intentId }),
        ]);
        return result(sig);
      },
      async claim({ intentId, to }) {
        const { escrow, vault } = await pdas(intentId);
        const state = await read(escrow);
        if (!state) return closedBy(escrow, "EscrowClaimed");
        const [payer, att] = await Promise.all([treasury, attestor]);
        if (state.attestor !== att.address) throw new Error(`Escrow ${escrow} names another attestor`);
        const recipient = address(to);
        const recipientToken = await ataOf(recipient);
        const sig = await sendAndConfirm([
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata: recipientToken, owner: recipient, mint }),
          getClaimInstruction({ programId, attestor: att, escrow, vault, recipient, recipientToken, mint, payer: state.payer }),
          getAddMemoInstruction({ memo: intentId }),
        ]);
        return result(sig);
      },
      async refund({ intentId }) {
        const { escrow, vault } = await pdas(intentId);
        const state = await read(escrow);
        if (!state) return closedBy(escrow, "EscrowRefunded");
        const payer = await treasury;
        const senderToken = await ataOf(state.sender);
        const sig = await sendAndConfirm([
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata: senderToken, owner: state.sender, mint }),
          getRefundInstruction({ programId, escrow, vault, sender: state.sender, senderToken, mint, payer: state.payer }),
          getAddMemoInstruction({ memo: intentId }),
        ]);
        return result(sig);
      },
    };
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
    async treasuryAddress() {
      return (await treasury).address;
    },
    async fund(to, amount) {
      return transfer(await treasury, address(to), amount, "dial signup drip");
    },
    ...(cfg.escrow ? { escrow: escrowProgram(cfg.escrow) } : {}),
  };
}

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
  type Signature,
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
import { fundingVerdict, TransferUnconfirmedError } from "./unconfirmed";
import {
  decodeEscrowAccount,
  type EscrowAccount,
  ESCROW_ERRORS,
  escrowErrorCode,
  escrowErrorName,
  escrowEventsFromLogs,
  findEscrowAddress,
  findVaultAddress,
  getClaimInstruction,
  getCreateEscrowInstruction,
  getRefundInstruction,
  intentIdHash,
} from "./solana-escrow";
import {
  EscrowClosedError,
  EscrowExpiredError,
  type EscrowLookup,
  type EscrowProgram,
  EscrowUnconfirmedError,
  NotLandedError,
  type SettlementAdapter,
  type SettleResult,
} from "./types";

const DECIMALS = 6;

/** Kit's error for a transaction the RPC simulated and rejected before sending: it never went out. */
const isPreflightFailure = (e: unknown) => (e as { context?: { __code?: unknown } }).context?.__code === -32002;
/** sendAndConfirm's error for a transaction that landed and failed: nothing moved. */
// Only our own message for a landed-and-failed transaction counts: an RPC error that merely says "failed:" must not.
const isFailedOnChain = (e: unknown) => e instanceof Error && /^Solana tx \S+ failed: /.test(e.message);

/** The program refused, the simulation failed, it failed on-chain, or its blockhash expired: it didn't land. */
const didNotLand = (e: unknown) => escrowErrorCode(e) !== null || e instanceof NotLandedError || isPreflightFailure(e) || isFailedOnChain(e);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A transaction's blockhash lasts about a minute: one the chain still hasn't seen this long after it went out never will. */
const NEVER_LANDS_AFTER_MS = 15 * 60_000;

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

  /** `sent.lastValidBlockHeight` is set once the transaction has a blockhash, so a caller can tell after a failure whether it could still land. */
  async function sendAndConfirm(instructions: Instruction[], sent: { lastValidBlockHeight?: bigint } = {}): Promise<string> {
    const feePayer = await treasury;
    const { value: latest } = await rl(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
    sent.lastValidBlockHeight = latest.lastValidBlockHeight;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const sig = getSignatureFromTransaction(tx);
    const wire = getBase64EncodedWireTransaction(tx);
    try {
      await rl(() => rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
    } catch (e) {
      // Refused by the simulation: it never went out. Anything else (a timeout, a 5xx) may have reached the network.
      if (isPreflightFailure(e)) throw e;
      throw new TransferUnconfirmedError("solana", sig, e);
    }
    // Wait until it lands or its blockhash expires (about a minute): after that it can't land, so a
    // timeout means nothing moved, not "maybe". An RPC that stops answering on the way is only waited out:
    // the transaction is out there, so without an answer it ends as TransferUnconfirmedError, never a failure.
    let lastError: unknown = null;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      let status;
      try {
        ({ value: [status] } = await rl(() => rpc.getSignatureStatuses([sig]).send()));
      } catch (e) {
        lastError = e;
        continue;
      }
      if (status?.err) throw new Error(`Solana tx ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return sig;
      if (i % 5 === 4) {
        try {
          const height = await rl(() => rpc.getBlockHeight({ commitment: "confirmed" }).send());
          if (height > latest.lastValidBlockHeight) {
            const { value: last } = await rl(() => rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send());
            if (!last[0]) throw new NotLandedError(sig);
          }
        } catch (e) {
          if (e instanceof NotLandedError) throw e;
          lastError = e;
        }
      }
    }
    throw new TransferUnconfirmedError("solana", sig, lastError ?? new Error("not confirmed in time"));
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

    /** Sends, and names the program's refusal: kit only says "Transaction simulation failed". */
    async function send(intentId: string, instructions: Instruction[], sent?: { lastValidBlockHeight?: bigint }): Promise<SettleResult> {
      try {
        return result(await sendAndConfirm(instructions, sent));
      } catch (e) {
        const code = escrowErrorCode(e);
        if (code === ESCROW_ERRORS.Expired) throw new EscrowExpiredError(intentId);
        if (code !== null) throw new Error(`dial_escrow refused: ${escrowErrorName(code)} (${code})`, { cause: e });
        throw e;
      }
    }

    /** The successful transactions that touched this escrow, oldest first. */
    async function history(escrow: Address) {
      const sigs = await rl(() => rpc.getSignaturesForAddress(escrow, { limit: 20, commitment: "confirmed" }).send());
      return sigs.filter((s) => !s.err).reverse();
    }

    async function events(signature: Signature) {
      const tx = await rl(() =>
        rpc.getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send(),
      );
      return escrowEventsFromLogs(tx?.meta?.logMessages ?? []);
    }

    async function lookup(intentId: string): Promise<EscrowLookup> {
      const { escrow } = await pdas(intentId);
      const state = await read(escrow);
      const done = await history(escrow);
      if (state) {
        // The funding transaction is the one whose logs carry this escrow's EscrowCreated event.
        let funded: SettleResult | null = null;
        for (const { signature } of done) {
          if ((await events(signature)).some((ev) => ev.name === "EscrowCreated" && ev.escrow === escrow)) {
            funded = result(signature);
            break;
          }
        }
        return { state: "open", sender: state.sender, amount: state.amount, expiresAt: new Date(Number(state.expiresAt) * 1000), funded };
      }
      for (const { signature } of [...done].reverse()) {
        const closing = (await events(signature)).find((ev) => ev.escrow === escrow && ev.name !== "EscrowCreated");
        if (closing) return { state: closing.name === "EscrowClaimed" ? "claimed" : "refunded", result: result(signature) };
      }
      return { state: "none" };
    }

    /** The escrow is gone. The same outcome we wanted (a send that timed out but landed) returns its transaction. */
    async function alreadyClosed(intentId: string, want: "claimed" | "refunded"): Promise<SettleResult> {
      const found = await lookup(intentId);
      if (found.state === want) return found.result;
      if (found.state === "claimed" || found.state === "refunded") throw new EscrowClosedError(found.state, found.result);
      throw new Error(`No escrow for ${intentId}`);
    }

    return {
      programId: e.programId,
      lookup,
      async vaultAddress(intentId) {
        return (await pdas(intentId)).vault;
      },
      async create({ fromSecret, intentId, amount, expiresAt }) {
        const [payer, sender, att] = await Promise.all([treasury, createKeyPairSignerFromPrivateKeyBytes(fromSecret), attestor]);
        const { hash, escrow, vault } = await pdas(intentId);
        const instructions = [
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
        ];
        const sent: { lastValidBlockHeight?: bigint } = {};
        try {
          return await send(intentId, instructions, sent);
        } catch (e) {
          // The escrow account is the truth: the send may have landed after we stopped waiting.
          const found = await lookup(intentId).catch(() => null);
          // "Nothing there" only settles it once the transaction can't land any more.
          const lastValid = sent.lastValidBlockHeight;
          const expired =
            lastValid === undefined ||
            (await rl(() => rpc.getBlockHeight({ commitment: "confirmed" }).send())
              .then((h) => h > lastValid)
              .catch(() => false));
          const verdict = fundingVerdict({ definite: didNotLand(e), found, sender: sender.address, amount, expired });
          if (verdict.kind === "funded") return verdict.result;
          if (verdict.kind === "failed") throw e;
          throw new EscrowUnconfirmedError(intentId, e);
        }
      },
      async claim({ intentId, to }) {
        const { escrow, vault } = await pdas(intentId);
        const state = await read(escrow);
        if (!state) return alreadyClosed(intentId, "claimed");
        const [payer, att] = await Promise.all([treasury, attestor]);
        if (state.attestor !== att.address) throw new Error(`Escrow ${escrow} names another attestor`);
        const recipient = address(to);
        const recipientToken = await ataOf(recipient);
        return send(intentId, [
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata: recipientToken, owner: recipient, mint }),
          getClaimInstruction({ programId, attestor: att, escrow, vault, recipient, recipientToken, mint, payer: state.payer }),
          getAddMemoInstruction({ memo: intentId }),
        ]);
      },
      async refund({ intentId }) {
        const { escrow, vault } = await pdas(intentId);
        const state = await read(escrow);
        if (!state) return alreadyClosed(intentId, "refunded");
        const payer = await treasury;
        const senderToken = await ataOf(state.sender);
        return send(intentId, [
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata: senderToken, owner: state.sender, mint }),
          getRefundInstruction({ programId, escrow, vault, sender: state.sender, senderToken, mint, payer: state.payer }),
          getAddMemoInstruction({ memo: intentId }),
        ]);
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
    async transferOutcome(txHash, { sentAt, now }) {
      const sig = txHash as Signature;
      const { value } = await rl(() => rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send());
      const status = value[0];
      if (status?.err) return { state: "failed" };
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return { state: "landed", result: { txHash, explorerUrl: cfg.explorerTx(txHash) } };
      }
      if (!status && now.getTime() - sentAt.getTime() > NEVER_LANDS_AFTER_MS) return { state: "failed" };
      return { state: "pending" };
    },
    ...(cfg.escrow ? { escrow: escrowProgram(cfg.escrow) } : {}),
  };
}

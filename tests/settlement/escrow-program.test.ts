import { readFileSync } from "node:fs";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  type Instruction,
  type KeyPairSigner,
  lamports,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  some,
} from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintEncoder,
  getTokenDecoder,
  getTokenEncoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeEscrowAccount,
  ESCROW_DISCRIMINATORS,
  ESCROW_ERRORS,
  escrowEventsFromLogs,
  findEscrowAddress,
  findVaultAddress,
  getClaimInstruction,
  getCreateEscrowInstruction,
  getRefundInstruction,
  intentIdHash,
} from "@/lib/settlement/solana-escrow";

// The built program (pnpm program:build) and its IDL, run in LiteSVM.
const PROGRAM_SO = "solana/artifacts/dial_escrow.so";
const idl = JSON.parse(readFileSync("solana/artifacts/dial_escrow.json", "utf8")) as {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string }[];
};
const PROGRAM = address(idl.address);
const NOW = 1_800_000_000n;
const DAY = 86_400n;
const SOL = lamports(10_000_000_000n);

type Result = TransactionMetadata | FailedTransactionMetadata;

let svm: LiteSVM;
let treasury: KeyPairSigner;
let sender: KeyPairSigner;
let attestor: KeyPairSigner;
let recipient: KeyPairSigner;
let mint: Address;

function setClock(unix: bigint) {
  const clock = svm.getClock();
  clock.unixTimestamp = unix;
  svm.setClock(clock);
}

function putMint(at: Address) {
  const data = getMintEncoder().encode({
    mintAuthority: some(treasury.address),
    supply: 1_000_000_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: none(),
  });
  svm.setAccount({ address: at, data: new Uint8Array(data), executable: false, lamports: SOL, programAddress: TOKEN_PROGRAM_ADDRESS, space: BigInt(data.length) });
}

async function ata(owner: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
}

/** Writes a USDC token account straight into the ledger. */
async function putTokenAccount(owner: Address, amount: bigint, at?: Address): Promise<Address> {
  const where = at ?? (await ata(owner));
  const data = getTokenEncoder().encode({
    mint,
    owner,
    amount,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  svm.setAccount({ address: where, data: new Uint8Array(data), executable: false, lamports: SOL, programAddress: TOKEN_PROGRAM_ADDRESS, space: BigInt(data.length) });
  return where;
}

function tokenBalance(at: Address): bigint | null {
  const acct = svm.getAccount(at);
  return acct.exists ? getTokenDecoder().decode(acct.data).amount : null;
}

function lamportsOf(at: Address): bigint {
  return svm.getBalance(at) ?? 0n;
}

async function send(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<Result> {
  svm.expireBlockhash();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  return svm.sendTransaction(tx);
}

function ok(r: Result): TransactionMetadata {
  if (r instanceof FailedTransactionMetadata) throw new Error(`tx failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
  return r;
}

/** The Anchor error number a failed transaction logged. */
function errorNumber(r: Result): number | null {
  expect(r).toBeInstanceOf(FailedTransactionMetadata);
  const line = (r as FailedTransactionMetadata).meta().logs().find((l) => l.includes("Error Number:"));
  return line ? Number(line.match(/Error Number: (\d+)/)?.[1]) : null;
}

async function pdas(intentId: string) {
  const hash = await intentIdHash(intentId);
  const escrow = await findEscrowAddress(PROGRAM, hash);
  return { hash, escrow, vault: await findVaultAddress(PROGRAM, escrow) };
}

async function createIx(intentId: string, amount: bigint, expiresAt = NOW + 7n * DAY, from = sender) {
  const { hash, escrow, vault } = await pdas(intentId);
  return getCreateEscrowInstruction({
    programId: PROGRAM,
    payer: treasury,
    sender: from,
    senderToken: await ata(from.address),
    mint,
    attestor: attestor.address,
    escrow,
    vault,
    intentIdHash: hash,
    amount,
    expiresAt,
  });
}

async function claimIx(intentId: string, opts: { signer?: KeyPairSigner; to?: Address; toToken?: Address; payer?: Address } = {}) {
  const { escrow, vault } = await pdas(intentId);
  const to = opts.to ?? recipient.address;
  return getClaimInstruction({
    programId: PROGRAM,
    attestor: opts.signer ?? attestor,
    escrow,
    vault,
    recipient: to,
    recipientToken: opts.toToken ?? (await ata(to)),
    mint,
    payer: opts.payer ?? treasury.address,
  });
}

async function refundIx(intentId: string, opts: { sender?: Address; senderToken?: Address } = {}) {
  const { escrow, vault } = await pdas(intentId);
  const who = opts.sender ?? sender.address;
  return getRefundInstruction({
    programId: PROGRAM,
    escrow,
    vault,
    sender: who,
    senderToken: opts.senderToken ?? (await ata(who)),
    mint,
    payer: treasury.address,
  });
}

beforeEach(async () => {
  svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM, PROGRAM_SO);
  setClock(NOW);
  treasury = await generateKeyPairSigner();
  sender = await generateKeyPairSigner();
  attestor = await generateKeyPairSigner();
  recipient = await generateKeyPairSigner();
  svm.airdrop(treasury.address, SOL);
  mint = (await generateKeyPairSigner()).address;
  putMint(mint);
  await putTokenAccount(sender.address, 100_000_000n);
  await putTokenAccount(recipient.address, 0n);
});

describe("dial_escrow program", () => {
  it("matches the IDL the client was written against", () => {
    const disc = (list: { name: string; discriminator: number[] }[], name: string) => list.find((x) => x.name === name)?.discriminator;
    expect(disc(idl.instructions, "create_escrow")).toEqual(ESCROW_DISCRIMINATORS.createEscrow);
    expect(disc(idl.instructions, "claim")).toEqual(ESCROW_DISCRIMINATORS.claim);
    expect(disc(idl.instructions, "refund")).toEqual(ESCROW_DISCRIMINATORS.refund);
    expect(disc(idl.accounts, "Escrow")).toEqual(ESCROW_DISCRIMINATORS.escrow);
    expect(disc(idl.events, "EscrowCreated")).toEqual(ESCROW_DISCRIMINATORS.escrowCreated);
    expect(disc(idl.events, "EscrowClaimed")).toEqual(ESCROW_DISCRIMINATORS.escrowClaimed);
    expect(disc(idl.events, "EscrowRefunded")).toEqual(ESCROW_DISCRIMINATORS.escrowRefunded);
    expect(Object.fromEntries(idl.errors.map((e) => [e.name, e.code]))).toEqual(ESCROW_ERRORS);
  });

  describe("create_escrow", () => {
    it("moves the sender's USDC into the intent's vault and records the escrow", async () => {
      const { escrow, vault, hash } = await pdas("pi_create");
      const r = ok(await send(treasury, [await createIx("pi_create", 12_500_000n)]));

      expect(tokenBalance(await ata(sender.address))).toBe(87_500_000n);
      expect(tokenBalance(vault)).toBe(12_500_000n);
      const acct = svm.getAccount(escrow);
      if (!acct.exists) throw new Error("no escrow account");
      expect(acct.programAddress).toBe(PROGRAM);
      expect(decodeEscrowAccount(acct.data)).toMatchObject({
        intentIdHash: hash,
        sender: sender.address,
        payer: treasury.address,
        attestor: attestor.address,
        mint,
        amount: 12_500_000n,
        createdAt: NOW,
        expiresAt: NOW + 7n * DAY,
      });
      expect(escrowEventsFromLogs(r.logs())).toEqual([
        {
          name: "EscrowCreated",
          intentIdHash: hash,
          escrow,
          sender: sender.address,
          attestor: attestor.address,
          mint,
          amount: 12_500_000n,
          expiresAt: NOW + 7n * DAY,
        },
      ]);
    });

    it("refuses a zero amount", async () => {
      expect(errorNumber(await send(treasury, [await createIx("pi_zero", 0n)]))).toBe(ESCROW_ERRORS.ZeroAmount);
    });

    it("refuses an expiry that has already passed", async () => {
      expect(errorNumber(await send(treasury, [await createIx("pi_past", 1n, NOW)]))).toBe(ESCROW_ERRORS.ExpiryInPast);
    });

    it("can't open a second escrow for the same intent", async () => {
      ok(await send(treasury, [await createIx("pi_twice", 1_000_000n)]));
      expect(await send(treasury, [await createIx("pi_twice", 2_000_000n)])).toBeInstanceOf(FailedTransactionMetadata);
      expect(tokenBalance(await ata(sender.address))).toBe(99_000_000n);
    });

    it("needs the sender's signature", async () => {
      const ix = await createIx("pi_nosig", 1_000_000n);
      const stripped = { ...ix, accounts: (ix.accounts ?? []).map((a) => (a.address === sender.address ? { address: a.address, role: 0 as const } : a)) };
      expect(await send(treasury, [stripped])).toBeInstanceOf(FailedTransactionMetadata);
    });
  });

  describe("claim", () => {
    beforeEach(async () => {
      ok(await send(treasury, [await createIx("pi_claim", 12_500_000n)]));
    });

    it("pays the recipient with the attestor's signature, closes the vault and returns the rent to the payer", async () => {
      const { escrow, vault, hash } = await pdas("pi_claim");
      const rent = lamportsOf(escrow) + lamportsOf(vault);
      const before = lamportsOf(treasury.address);

      const r = ok(await send(treasury, [await claimIx("pi_claim")]));

      expect(tokenBalance(await ata(recipient.address))).toBe(12_500_000n);
      expect(svm.getAccount(vault).exists).toBe(false);
      expect(svm.getAccount(escrow).exists).toBe(false);
      // Two signatures (treasury and attestor) at 5000 lamports each.
      expect(lamportsOf(treasury.address)).toBe(before + rent - 10_000n);
      expect(escrowEventsFromLogs(r.logs())).toEqual([
        { name: "EscrowClaimed", intentIdHash: hash, escrow, recipient: recipient.address, amount: 12_500_000n },
      ]);
    });

    it("refuses any signer but the escrow's attestor", async () => {
      const impostor = await generateKeyPairSigner();
      svm.airdrop(impostor.address, SOL);
      const r = await send(impostor, [await claimIx("pi_claim", { signer: impostor })]);
      expect(errorNumber(r)).toBe(ESCROW_ERRORS.WrongAttestor);
      expect(tokenBalance((await pdas("pi_claim")).vault)).toBe(12_500_000n);
    });

    it("can't be claimed twice", async () => {
      ok(await send(treasury, [await claimIx("pi_claim")]));
      const other = await generateKeyPairSigner();
      await putTokenAccount(other.address, 0n);
      expect(await send(treasury, [await claimIx("pi_claim", { to: other.address })])).toBeInstanceOf(FailedTransactionMetadata);
      expect(tokenBalance(await ata(other.address))).toBe(0n);
    });

    it("can't be claimed after expiry", async () => {
      setClock(NOW + 7n * DAY);
      expect(errorNumber(await send(treasury, [await claimIx("pi_claim")]))).toBe(ESCROW_ERRORS.Expired);
    });

    it("only pays the recipient's associated token account", async () => {
      const stray = (await generateKeyPairSigner()).address;
      await putTokenAccount(recipient.address, 0n, stray);
      const r = await send(treasury, [await claimIx("pi_claim", { toToken: stray })]);
      expect(errorNumber(r)).toBe(ESCROW_ERRORS.NotAssociatedTokenAccount);
    });

    it("sends the rent back only to the payer that put it up", async () => {
      const r = await send(treasury, [await claimIx("pi_claim", { payer: recipient.address })]);
      expect(r).toBeInstanceOf(FailedTransactionMetadata);
    });

    it("still closes when someone sends extra tokens to the vault", async () => {
      const { vault } = await pdas("pi_claim");
      ok(
        await send(treasury, [
          getTransferCheckedInstruction({ source: await ata(sender.address), mint, destination: vault, authority: sender, amount: 1n, decimals: 6 }),
        ]),
      );
      ok(await send(treasury, [await claimIx("pi_claim")]));
      expect(tokenBalance(await ata(recipient.address))).toBe(12_500_001n);
      expect(svm.getAccount(vault).exists).toBe(false);
    });

    it("works in one transaction with creating the recipient's token account", async () => {
      const fresh = await generateKeyPairSigner();
      const token = await ata(fresh.address);
      ok(
        await send(treasury, [
          getCreateAssociatedTokenIdempotentInstruction({ payer: treasury, ata: token, owner: fresh.address, mint }),
          await claimIx("pi_claim", { to: fresh.address }),
        ]),
      );
      expect(tokenBalance(token)).toBe(12_500_000n);
    });
  });

  describe("refund", () => {
    beforeEach(async () => {
      ok(await send(treasury, [await createIx("pi_refund", 30_000_000n)]));
    });

    it("can't run before expiry", async () => {
      setClock(NOW + 7n * DAY - 1n);
      expect(errorNumber(await send(treasury, [await refundIx("pi_refund")]))).toBe(ESCROW_ERRORS.NotExpired);
    });

    it("after expiry, anyone can return the money to the sender; rent goes back to the payer", async () => {
      setClock(NOW + 7n * DAY);
      const { escrow, vault, hash } = await pdas("pi_refund");
      const rent = lamportsOf(escrow) + lamportsOf(vault);
      const before = lamportsOf(treasury.address);
      const stranger = await generateKeyPairSigner();
      svm.airdrop(stranger.address, SOL);

      const r = ok(await send(stranger, [await refundIx("pi_refund")]));

      expect(tokenBalance(await ata(sender.address))).toBe(100_000_000n);
      expect(svm.getAccount(escrow).exists).toBe(false);
      expect(svm.getAccount(vault).exists).toBe(false);
      expect(lamportsOf(treasury.address)).toBe(before + rent);
      expect(escrowEventsFromLogs(r.logs())).toEqual([
        { name: "EscrowRefunded", intentIdHash: hash, escrow, sender: sender.address, amount: 30_000_000n },
      ]);
    });

    it("can't send the money anywhere but the sender", async () => {
      setClock(NOW + 8n * DAY);
      const thief = await generateKeyPairSigner();
      svm.airdrop(thief.address, SOL);
      const thiefToken = await putTokenAccount(thief.address, 0n);

      expect(await send(thief, [await refundIx("pi_refund", { sender: thief.address })])).toBeInstanceOf(FailedTransactionMetadata);
      expect(errorNumber(await send(thief, [await refundIx("pi_refund", { senderToken: thiefToken })]))).toBe(
        ESCROW_ERRORS.NotAssociatedTokenAccount,
      );
      expect(tokenBalance(thiefToken)).toBe(0n);
      expect(tokenBalance((await pdas("pi_refund")).vault)).toBe(30_000_000n);
    });

    it("can't run after a claim", async () => {
      ok(await send(treasury, [await claimIx("pi_refund")]));
      setClock(NOW + 8n * DAY);
      expect(await send(treasury, [await refundIx("pi_refund")])).toBeInstanceOf(FailedTransactionMetadata);
      expect(tokenBalance(await ata(sender.address))).toBe(70_000_000n);
    });

    it("can't run twice", async () => {
      setClock(NOW + 7n * DAY);
      ok(await send(treasury, [await refundIx("pi_refund")]));
      expect(await send(treasury, [await refundIx("pi_refund")])).toBeInstanceOf(FailedTransactionMetadata);
      expect(tokenBalance(await ata(sender.address))).toBe(100_000_000n);
    });
  });
});

import {
  type AccountMeta,
  AccountRole,
  type AccountSignerMeta,
  type Address,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getBytesDecoder,
  getBytesEncoder,
  getI64Decoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU8Decoder,
  getU64Decoder,
  getU64Encoder,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

/**
 * Client for the dial_escrow program (solana/programs/dial_escrow). Discriminators and layouts come from
 * its IDL, solana/artifacts/dial_escrow.json; tests/settlement/escrow-program.test.ts checks they match.
 */

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

/** An instruction whose signer accounts carry their signers, so signTransactionMessageWithSigners finds them. */
export type EscrowInstruction = Instruction<string, readonly (AccountMeta | AccountSignerMeta)[]>;

export const ESCROW_DISCRIMINATORS = {
  createEscrow: [253, 215, 165, 116, 36, 108, 68, 80],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  refund: [2, 96, 183, 251, 63, 208, 46, 46],
  escrow: [31, 213, 123, 187, 186, 22, 218, 155],
  escrowCreated: [70, 127, 105, 102, 92, 97, 7, 173],
  escrowClaimed: [32, 116, 46, 229, 165, 72, 108, 78],
  escrowRefunded: [132, 209, 49, 109, 135, 138, 28, 81],
} as const;

/** The program's error codes, from the IDL. */
export const ESCROW_ERRORS = {
  ZeroAmount: 6000,
  ExpiryInPast: 6001,
  Expired: 6002,
  NotExpired: 6003,
  WrongAttestor: 6004,
  NotAssociatedTokenAccount: 6005,
} as const;

/**
 * The program's error code behind a failed send, if it was the program that refused. Kit reports a failed
 * preflight as "Transaction simulation failed" and puts the instruction error ({ code: 6002 }) in a cause.
 */
export function escrowErrorCode(e: unknown): number | null {
  const codes = new Set<number>(Object.values(ESCROW_ERRORS));
  for (let at: unknown = e, depth = 0; at && depth < 5; depth++) {
    const code = (at as { context?: { code?: unknown } }).context?.code;
    if (typeof code === "number" && codes.has(code)) return code;
    at = (at as { cause?: unknown }).cause;
  }
  return null;
}

/** "WrongAttestor" for 6004, and so on. */
export function escrowErrorName(code: number): string | null {
  return Object.entries(ESCROW_ERRORS).find(([, c]) => c === code)?.[0] ?? null;
}

const hash32 = fixEncoderSize(getBytesEncoder(), 32);
const hash32Decoder = fixDecoderSize(getBytesDecoder(), 32);
const encoder = new TextEncoder();

/** The escrow is keyed by SHA-256 of the Dial intent id, so anyone holding the id can find it on-chain. */
export async function intentIdHash(intentId: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(intentId)));
}

export async function findEscrowAddress(programId: Address, idHash: ReadonlyUint8Array): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: [encoder.encode("escrow"), idHash] });
  return pda;
}

/** The token account holding the money. Its address is known before the escrow exists. */
export async function findVaultAddress(programId: Address, escrow: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [encoder.encode("vault"), getAddressEncoder().encode(escrow)],
  });
  return pda;
}

const withDiscriminator = (d: readonly number[], body: ReadonlyUint8Array): Uint8Array => {
  const out = new Uint8Array(8 + body.length);
  out.set(d);
  out.set(body, 8);
  return out;
};

const createArgs = getStructEncoder([
  ["intentIdHash", hash32],
  ["amount", getU64Encoder()],
  ["expiresAt", getI64Encoder()],
]);

export function getCreateEscrowInstruction(input: {
  programId: Address;
  payer: TransactionSigner;
  sender: TransactionSigner;
  senderToken: Address;
  mint: Address;
  attestor: Address;
  escrow: Address;
  vault: Address;
  intentIdHash: ReadonlyUint8Array;
  amount: bigint;
  /** Unix seconds. */
  expiresAt: bigint;
}): EscrowInstruction {
  return {
    programAddress: input.programId,
    accounts: [
      { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer },
      { address: input.sender.address, role: AccountRole.READONLY_SIGNER, signer: input.sender },
      { address: input.senderToken, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.attestor, role: AccountRole.READONLY },
      { address: input.escrow, role: AccountRole.WRITABLE },
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: withDiscriminator(ESCROW_DISCRIMINATORS.createEscrow, createArgs.encode(input)),
  };
}

export function getClaimInstruction(input: {
  programId: Address;
  attestor: TransactionSigner;
  escrow: Address;
  vault: Address;
  recipient: Address;
  recipientToken: Address;
  mint: Address;
  /** The escrow's recorded payer; gets the rent back. */
  payer: Address;
}): EscrowInstruction {
  return {
    programAddress: input.programId,
    accounts: [
      { address: input.attestor.address, role: AccountRole.READONLY_SIGNER, signer: input.attestor },
      { address: input.escrow, role: AccountRole.WRITABLE },
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.recipientToken, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.payer, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: withDiscriminator(ESCROW_DISCRIMINATORS.claim, getAddressEncoder().encode(input.recipient)),
  };
}

/** Needs no signer from Dial or the sender: whoever sends the transaction pays its fee. */
export function getRefundInstruction(input: {
  programId: Address;
  escrow: Address;
  vault: Address;
  sender: Address;
  senderToken: Address;
  mint: Address;
  payer: Address;
}): EscrowInstruction {
  return {
    programAddress: input.programId,
    accounts: [
      { address: input.escrow, role: AccountRole.WRITABLE },
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.sender, role: AccountRole.READONLY },
      { address: input.senderToken, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: input.payer, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(ESCROW_DISCRIMINATORS.refund),
  };
}

export type EscrowAccount = {
  intentIdHash: ReadonlyUint8Array;
  sender: Address;
  payer: Address;
  attestor: Address;
  mint: Address;
  amount: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  bump: number;
  vaultBump: number;
};

const escrowDecoder = getStructDecoder([
  ["intentIdHash", hash32Decoder],
  ["sender", getAddressDecoder()],
  ["payer", getAddressDecoder()],
  ["attestor", getAddressDecoder()],
  ["mint", getAddressDecoder()],
  ["amount", getU64Decoder()],
  ["createdAt", getI64Decoder()],
  ["expiresAt", getI64Decoder()],
  ["bump", getU8Decoder()],
  ["vaultBump", getU8Decoder()],
]);

const startsWith = (data: ReadonlyUint8Array, d: readonly number[]) => d.every((b, i) => data[i] === b);

export function decodeEscrowAccount(data: ReadonlyUint8Array): EscrowAccount {
  if (!startsWith(data, ESCROW_DISCRIMINATORS.escrow)) throw new Error("Not a dial_escrow Escrow account");
  return escrowDecoder.decode(data, 8);
}

export type EscrowEvent =
  | { name: "EscrowCreated"; intentIdHash: ReadonlyUint8Array; escrow: Address; sender: Address; attestor: Address; mint: Address; amount: bigint; expiresAt: bigint }
  | { name: "EscrowClaimed"; intentIdHash: ReadonlyUint8Array; escrow: Address; recipient: Address; amount: bigint }
  | { name: "EscrowRefunded"; intentIdHash: ReadonlyUint8Array; escrow: Address; sender: Address; amount: bigint };

const createdDecoder = getStructDecoder([
  ["intentIdHash", hash32Decoder],
  ["escrow", getAddressDecoder()],
  ["sender", getAddressDecoder()],
  ["attestor", getAddressDecoder()],
  ["mint", getAddressDecoder()],
  ["amount", getU64Decoder()],
  ["expiresAt", getI64Decoder()],
]);
const claimedDecoder = getStructDecoder([
  ["intentIdHash", hash32Decoder],
  ["escrow", getAddressDecoder()],
  ["recipient", getAddressDecoder()],
  ["amount", getU64Decoder()],
]);
const refundedDecoder = getStructDecoder([
  ["intentIdHash", hash32Decoder],
  ["escrow", getAddressDecoder()],
  ["sender", getAddressDecoder()],
  ["amount", getU64Decoder()],
]);

const INVOKE = /^Program (\S+) invoke \[\d+\]$/;
const RETURN = /^Program (\S+) (?:success$|failed)/;

/**
 * The program's events from a transaction's log lines (Anchor writes them as "Program data: <base64>").
 * Only data written while `programId` itself is running counts: any program can log bytes that decode as
 * an EscrowClaimed, in a transaction that merely lists the escrow's address. Which program is running comes
 * from the runtime's own "invoke" and "success"/"failed" lines, which no program can write.
 */
export function escrowEventsFromLogs(logs: readonly string[], programId: string): EscrowEvent[] {
  const events: EscrowEvent[] = [];
  const running: string[] = [];
  for (const line of logs) {
    const invoked = INVOKE.exec(line);
    if (invoked?.[1]) {
      running.push(invoked[1]);
      continue;
    }
    if (RETURN.exec(line)?.[1] === running.at(-1)) {
      running.pop();
      continue;
    }
    if (!line.startsWith("Program data: ") || running.at(-1) !== programId) continue;
    const data = getBase64Encoder().encode(line.slice("Program data: ".length));
    if (startsWith(data, ESCROW_DISCRIMINATORS.escrowCreated)) {
      events.push({ name: "EscrowCreated", ...createdDecoder.decode(data, 8) });
    } else if (startsWith(data, ESCROW_DISCRIMINATORS.escrowClaimed)) {
      events.push({ name: "EscrowClaimed", ...claimedDecoder.decode(data, 8) });
    } else if (startsWith(data, ESCROW_DISCRIMINATORS.escrowRefunded)) {
      events.push({ name: "EscrowRefunded", ...refundedDecoder.decode(data, 8) });
    }
  }
  return events;
}

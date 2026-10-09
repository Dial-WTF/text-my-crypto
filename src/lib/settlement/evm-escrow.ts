import {
  type Address,
  BaseError,
  bytesToHex,
  type Chain as ViemChain,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseSignature,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withRateLimitRetry as rl } from "./retry";
import { EscrowClosedError, EscrowExpiredError, type EscrowLookup, type EscrowProgram, EscrowUnconfirmedError, type SettleResult } from "./types";
import { fundingVerdict } from "./unconfirmed";

/**
 * Client for dial_escrow on Arbitrum, the Stylus contract in contracts/arbitrum-escrow. One contract
 * holds every escrow, keyed by keccak256 of the Dial intent id. Dial's wallets hold no ETH, so the
 * treasury sends the funding and the refund with the sender's signatures; the attestor sends claims
 * itself, because the contract only takes a claim from the attestor's address.
 */

export const ESCROW_ABI = parseAbi([
  "function attestor() view returns (address)",
  "function escrow(bytes32 id) view returns (address sender, address token, uint256 amount, uint64 expiry, uint8 status, uint64 fundedBlock, uint64 closedBlock)",
  "function fundWithAuthorization(bytes32 id, address token, address from, uint256 amount, uint64 expiry, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function claim(bytes32 id, address to)",
  "function refundWithSignature(bytes32 id, uint8 v, bytes32 r, bytes32 s)",
  "event Funded(bytes32 indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiry)",
  "event Claimed(bytes32 indexed id, address indexed to, uint256 amount)",
  "event Refunded(bytes32 indexed id, address indexed sender, uint256 amount)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error ExpiryInPast()",
  "error AlreadyFunded(bytes32 id)",
  "error NotOpen(bytes32 id)",
  "error NotAttestor()",
  "error NotSender()",
  "error Expired()",
  "error NotExpired()",
  "error BadSignature()",
  "error NoCode(address token)",
  "error TokenCallFailed(address token)",
  "error ArbSysFailed()",
  "error Reentrancy()",
]);

/** A funding authorization stops working this long after it is signed. The reconciler gives up on a funding after 15 minutes, and by then it can't land. */
export const FUNDING_WINDOW_S = 10 * 60;
/** The attestor pays for its own claims. Below this balance the treasury tops it up. */
export const ATTESTOR_MIN_WEI = 200_000_000_000_000n; // 0.0002 ETH, about 15 claims
export const ATTESTOR_TOPUP_WEI = 1_000_000_000_000_000n; // 0.001 ETH

/** The escrow's key: keccak256 of the intent id, so anyone with the id from a receipt can find it. */
export const escrowId = (intentId: string): Hex => keccak256(stringToHex(intentId));

/** The EIP-3009 nonce the contract expects for a funding: keccak256(abi.encode(id, expiry)). */
export const fundingNonce = (id: Hex, expiry: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [id, expiry]));

type Vrs = { v: number; r: Hex; s: Hex };

function vrs(signature: Hex): Vrs {
  const { r, s, v, yParity } = parseSignature(signature);
  return { v: Number(v ?? BigInt(yParity + 27)), r, s };
}

/** The sender's EIP-3009 receiveWithAuthorization for funding escrow `id`. Pure: no network. */
export async function signFunding(args: {
  secret: Uint8Array<ArrayBuffer>;
  token: Address;
  domain: { name: string; version: string };
  chainId: number;
  contract: Address;
  id: Hex;
  amount: bigint;
  expiry: bigint;
  validBefore: bigint;
}): Promise<Vrs & { from: Address }> {
  const account = privateKeyToAccount(bytesToHex(args.secret));
  const signature = await account.signTypedData({
    domain: { name: args.domain.name, version: args.domain.version, chainId: args.chainId, verifyingContract: args.token },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: account.address,
      to: args.contract,
      value: args.amount,
      validAfter: 0n,
      validBefore: args.validBefore,
      nonce: fundingNonce(args.id, args.expiry),
    },
  });
  return { from: account.address, ...vrs(signature) };
}

/** The sender's EIP-712 Refund(bytes32 id), which lets the treasury send the refund for them. Pure: no network. */
export async function signRefund(args: {
  secret: Uint8Array<ArrayBuffer>;
  chainId: number;
  contract: Address;
  id: Hex;
}): Promise<Vrs & { from: Address }> {
  const account = privateKeyToAccount(bytesToHex(args.secret));
  const signature = await account.signTypedData({
    domain: { name: "DialEscrow", version: "1", chainId: args.chainId, verifyingContract: args.contract },
    types: { Refund: [{ name: "id", type: "bytes32" }] },
    primaryType: "Refund",
    message: { id: args.id },
  });
  return { from: account.address, ...vrs(signature) };
}

export type OnChainEscrow = {
  status: "none" | "open" | "claimed" | "refunded";
  sender: Address;
  token: Address;
  amount: bigint;
  /** Unix seconds. */
  expiry: bigint;
  fundedBlock: bigint;
  closedBlock: bigint;
};

const STATUSES = ["none", "open", "claimed", "refunded"] as const;

/** The contract refused the call when it was simulated, so nothing was sent. `reason` is its error's name. */
export class EscrowRefusedError extends Error {
  constructor(
    readonly reason: string,
    cause: unknown,
  ) {
    super(`dial_escrow refused: ${reason}`, { cause });
    this.name = "EscrowRefusedError";
  }
}

/** The transaction landed and reverted: nothing moved. */
class RevertedError extends Error {
  constructor(hash: Hex) {
    super(`dial_escrow tx ${hash} reverted`);
    this.name = "RevertedError";
  }
}

/** The contract's error name behind a failed write, if it was the contract that refused. */
export function refusalOf(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
}

/** The chain calls the escrow makes. Writes resolve with the hash once sent and throw EscrowRefusedError when the contract refuses up front. */
export interface EscrowRpc {
  escrow(id: Hex): Promise<OnChainEscrow>;
  /** The transaction that emitted the contract's `event` for `id` in `block`, or null. */
  eventTx(event: "Funded" | "Claimed" | "Refunded", id: Hex, block: bigint): Promise<Hex | null>;
  tokenDomain(): Promise<{ name: string; version: string }>;
  fundWithAuthorization(args: { id: Hex; from: Address; amount: bigint; expiry: bigint; validBefore: bigint } & Vrs): Promise<Hex>;
  claim(id: Hex, to: Address): Promise<Hex>;
  refundWithSignature(id: Hex, sig: Vrs): Promise<Hex>;
  /** Waits for the receipt (throws if it doesn't come). */
  receipt(hash: Hex): Promise<"success" | "reverted">;
  attestorBalance(): Promise<bigint>;
  /** The treasury sends the attestor `wei` for gas. */
  topUpAttestor(wei: bigint): Promise<Hex>;
}

export function createEvmEscrow(cfg: {
  contract: Address;
  token: Address;
  chainId: number;
  explorerTx: (hash: string) => string | null;
  rpc: EscrowRpc;
  now?: () => number;
}): EscrowProgram {
  const { rpc, contract } = cfg;
  const now = cfg.now ?? Date.now;
  const result = (hash: string): SettleResult => ({ txHash: hash, explorerUrl: cfg.explorerTx(hash) });

  async function confirmed(hash: Hex): Promise<SettleResult> {
    if ((await rpc.receipt(hash)) === "reverted") throw new RevertedError(hash);
    return result(hash);
  }

  /**
   * The escrow at `id`. The contract keeps escrows in any token, and anyone can open one in a sender's name
   * with a token that skips the sender's signature, so only one holding our token can be this payment's.
   */
  async function read(id: Hex, intentId: string): Promise<OnChainEscrow> {
    const e = await rl(() => rpc.escrow(id));
    if (e.status !== "none" && !isAddressEqual(e.token, cfg.token)) throw new Error(`Escrow for ${intentId} holds another token (${e.token})`);
    return e;
  }

  async function lookup(intentId: string): Promise<EscrowLookup> {
    const id = escrowId(intentId);
    const e = await read(id, intentId);
    if (e.status === "none") return { state: "none" };
    if (e.status === "open") {
      const funded = await rl(() => rpc.eventTx("Funded", id, e.fundedBlock));
      return { state: "open", sender: e.sender, amount: e.amount, expiresAt: new Date(Number(e.expiry) * 1000), funded: funded ? result(funded) : null };
    }
    const closing = await rl(() => rpc.eventTx(e.status === "claimed" ? "Claimed" : "Refunded", id, e.closedBlock));
    if (!closing) throw new Error(`No ${e.status} event for ${intentId} in block ${e.closedBlock}`);
    return { state: e.status, result: result(closing) };
  }

  /** The escrow isn't open. The same outcome we wanted (a send that timed out but landed) returns its transaction. */
  async function alreadyClosed(intentId: string, want: "claimed" | "refunded"): Promise<SettleResult> {
    const found = await lookup(intentId);
    if (found.state === want) return found.result;
    if (found.state === "claimed" || found.state === "refunded") throw new EscrowClosedError(found.state, found.result);
    throw new Error(`No escrow for ${intentId}`);
  }

  return {
    programId: contract,
    lookup,
    async vaultAddress() {
      return contract;
    },
    async create({ fromSecret, intentId, amount, expiresAt }) {
      const id = escrowId(intentId);
      const expiry = BigInt(Math.floor(expiresAt.getTime() / 1000));
      const validBefore = BigInt(Math.floor(now() / 1000) + FUNDING_WINDOW_S);
      const domain = await rl(() => rpc.tokenDomain());
      const sig = await signFunding({ secret: fromSecret, token: cfg.token, domain, chainId: cfg.chainId, contract, id, amount, expiry, validBefore });
      try {
        return await confirmed(await rl(() => rpc.fundWithAuthorization({ id, amount, expiry, validBefore, ...sig })));
      } catch (e) {
        // The contract is the truth: the send may have landed after we stopped waiting.
        const found = await lookup(intentId).catch(() => null);
        const definite = e instanceof EscrowRefusedError || e instanceof RevertedError;
        // Past validBefore the token refuses the authorization, so "nothing there" is final.
        const expired = now() / 1000 > Number(validBefore);
        const verdict = fundingVerdict({ definite, found, sender: sig.from, amount, expired });
        if (verdict.kind === "funded") return verdict.result;
        if (verdict.kind === "failed") throw e;
        throw new EscrowUnconfirmedError(intentId, e);
      }
    },
    async claim({ intentId, to }) {
      const id = escrowId(intentId);
      if ((await read(id, intentId)).status !== "open") return alreadyClosed(intentId, "claimed");
      if ((await rl(() => rpc.attestorBalance())) < ATTESTOR_MIN_WEI) {
        await confirmed(await rl(() => rpc.topUpAttestor(ATTESTOR_TOPUP_WEI)));
      }
      let hash: Hex;
      try {
        hash = await rl(() => rpc.claim(id, to as Address));
      } catch (e) {
        if (e instanceof EscrowRefusedError && e.reason === "Expired") throw new EscrowExpiredError(intentId);
        if (e instanceof EscrowRefusedError && e.reason === "NotOpen") return alreadyClosed(intentId, "claimed");
        throw e;
      }
      return confirmed(hash);
    },
    async refund({ intentId, senderSecret }) {
      const id = escrowId(intentId);
      const e = await read(id, intentId);
      if (e.status !== "open") return alreadyClosed(intentId, "refunded");
      if (!senderSecret) throw new Error(`Escrow ${intentId} refunds only on its sender's signature`);
      const sig = await signRefund({ secret: senderSecret, chainId: cfg.chainId, contract, id });
      if (sig.from !== e.sender) throw new Error(`Escrow ${intentId} was funded by another wallet`);
      let hash: Hex;
      try {
        hash = await rl(() => rpc.refundWithSignature(id, sig));
      } catch (err) {
        if (err instanceof EscrowRefusedError && err.reason === "NotOpen") return alreadyClosed(intentId, "refunded");
        throw err;
      }
      return confirmed(hash);
    },
  };
}

/** EscrowRpc over viem. The treasury sends fundings, refunds and attestor top-ups; the attestor sends claims. */
export function viemEscrowRpc(cfg: {
  viem: ViemChain;
  rpcUrl?: string;
  contract: Address;
  treasuryKey: Hex;
  attestorKey: Hex;
  token: Address;
  tokenDomain: () => Promise<{ name: string; version: string }>;
}): EscrowRpc {
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: cfg.viem, transport });
  const treasury = createWalletClient({ chain: cfg.viem, transport, account: privateKeyToAccount(cfg.treasuryKey) });
  const attestor = createWalletClient({ chain: cfg.viem, transport, account: privateKeyToAccount(cfg.attestorKey) });
  const { contract } = cfg;

  /** Names the contract's refusal: viem only says the call reverted. */
  const refused = async (send: () => Promise<Hex>): Promise<Hex> => {
    try {
      return await send();
    } catch (e) {
      const reason = refusalOf(e);
      throw reason ? new EscrowRefusedError(reason, e) : e;
    }
  };

  return {
    async escrow(id) {
      const [sender, token, amount, expiry, status, fundedBlock, closedBlock] = await publicClient.readContract({
        address: contract,
        abi: ESCROW_ABI,
        functionName: "escrow",
        args: [id],
      });
      return { status: STATUSES[status] ?? "none", sender, token, amount, expiry, fundedBlock, closedBlock };
    },
    async eventTx(event, id, block) {
      const item = ESCROW_ABI.find((x) => x.type === "event" && x.name === event);
      if (item?.type !== "event") throw new Error(`No ${event} event in the ABI`);
      const logs = await publicClient.getLogs({ address: contract, event: item, args: { id }, fromBlock: block, toBlock: block });
      return logs[0]?.transactionHash ?? null;
    },
    tokenDomain: cfg.tokenDomain,
    fundWithAuthorization: ({ id, from, amount, expiry, validBefore, v, r, s }) =>
      refused(() =>
        treasury.writeContract({
          address: contract,
          abi: ESCROW_ABI,
          functionName: "fundWithAuthorization",
          args: [id, cfg.token, from, amount, expiry, validBefore, v, r, s],
        }),
      ),
    claim: (id, to) => refused(() => attestor.writeContract({ address: contract, abi: ESCROW_ABI, functionName: "claim", args: [id, to] })),
    refundWithSignature: (id, { v, r, s }) =>
      refused(() => treasury.writeContract({ address: contract, abi: ESCROW_ABI, functionName: "refundWithSignature", args: [id, v, r, s] })),
    async receipt(hash) {
      return (await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })).status;
    },
    attestorBalance: () => publicClient.getBalance({ address: attestor.account.address }),
    topUpAttestor: (wei) => treasury.sendTransaction({ to: attestor.account.address, value: wei }),
  };
}

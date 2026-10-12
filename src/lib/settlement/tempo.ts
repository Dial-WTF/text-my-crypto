import {
  type Address,
  bytesToHex,
  encodeFunctionData,
  type Hex,
  isAddress,
  isAddressEqual,
  keccak256,
  type Log,
  pad,
  parseEventLogs,
  size,
  stringToHex,
  TransactionReceiptNotFoundError,
} from "viem";
import { tempo, tempoModerato } from "viem/chains";
import { Abis, Account, createClient, http } from "viem/tempo";
import { withRateLimitRetry as rl } from "./retry";
import type { TransferLeg } from "./capabilities";
import { HeldBackError, type SettlementAdapter, type SettleResult } from "./types";
import { TransferUnconfirmedError } from "./unconfirmed";

/** AlphaUSD on Moderato: TIP-20, 6 decimals. Also the fee token, since Tempo has no native gas coin. */
export const ALPHA_USD: Address = "0x20c0000000000000000000000000000000000001";
const TEMPO_EXPLORER = "https://explore.testnet.tempo.xyz";

/**
 * TIP-20 memos are 32 bytes. Payment ids ("pi_" + 16 chars) fit as plain UTF-8, right-padded so they
 * read as text in the explorer. Anything longer is hashed so the memo still binds to the payment.
 */
export function encodeMemo(memo: string): Hex {
  const hex = stringToHex(memo);
  return size(hex) <= 32 ? pad(hex, { size: 32, dir: "right" }) : keccak256(hex);
}

/**
 * True when the receipt logs show `amount` of `token` moving from `from` (any sender, when absent) to `to`.
 * A transfer the recipient's receive policy blocks still succeeds at the transaction level, but the funds
 * land in the policy guard instead, so a successful status alone is not proof of delivery.
 */
export function deliveredTo(
  logs: readonly Log[],
  expected: { token: Address; from?: Address; to: Address; amount: bigint },
): boolean {
  return parseEventLogs({ abi: Abis.tip20, eventName: "Transfer", logs: [...logs] }).some(
    (l) =>
      isAddressEqual(l.address, expected.token) &&
      (!expected.from || isAddressEqual(l.args.from, expected.from)) &&
      isAddressEqual(l.args.to, expected.to) &&
      l.args.amount === expected.amount,
  );
}

/**
 * One TIP-20 `transferWithMemo` call per leg, for a single Tempo transaction. Tempo transactions carry a
 * list of calls that execute atomically: every leg lands, or the whole transaction reverts and none do.
 */
export function batchCalls(token: Address, legs: readonly TransferLeg[]): { to: Address; data: Hex }[] {
  return legs.map((leg) => ({
    to: token,
    data: encodeFunctionData({
      abi: Abis.tip20,
      functionName: "transferWithMemo",
      args: [leg.to as Address, leg.amount, encodeMemo(leg.memo)],
    }),
  }));
}

/** Most legs one batch carries. Splits stop at 10 people; this leaves room without inviting huge transactions. */
const MAX_BATCH_LEGS = 16;

/**
 * Every send goes out on Tempo's expiring nonces, valid for this long after it is signed: the chain won't
 * include it in a block stamped at or after its `validBefore`, so one it hasn't mined by then never will be.
 * (Expiring nonces are also what lets the treasury sponsor many sends at once without queuing on one nonce.)
 */
const VALID_FOR_S = 25;
/** After `validBefore`, how far the chain's head must have moved before a missing receipt means "never landed". */
const EXPIRY_MARGIN_S = 10;
/** Upper bound on the wait for a receipt while the RPC is failing; past it the send is left unconfirmed. */
const CONFIRM_POLLS = 90;
/**
 * For transfers asked about later, when only the approval time is known: a transaction the chain still
 * doesn't know this long after its payment was approved never landed. It was signed within the approval's
 * request (a couple of minutes at the very worst) and could land for 25 seconds after that; the rest is room
 * for clocks that disagree.
 */
const NEVER_LANDS_AFTER_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type TempoConfig = {
  treasuryKey: Hex;
  rpcUrl?: string;
  token?: Address;
  /** Moderato unless the registry says otherwise. */
  viem?: typeof tempoModerato | typeof tempo;
  explorerTx?: (hash: string) => string;
  /** Top the treasury up from the testnet faucet when it runs short. Testnet only. */
  faucet?: boolean;
};

/**
 * AlphaUSD on Tempo Moderato. Every transfer carries the payment id as its TIP-20 memo, and the
 * treasury co-signs as fee payer so user and escrow wallets never need to hold anything for fees.
 */
export function createTempoAdapter(cfg: TempoConfig): SettlementAdapter {
  const token = cfg.token ?? ALPHA_USD;
  const chain = cfg.viem ?? tempoModerato;
  const transport = http(cfg.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const treasury = Account.fromSecp256k1(cfg.treasuryKey);
  const client = createClient({ chain, feeToken: token, transport, account: treasury });

  const explorerTx = cfg.explorerTx ?? ((hash: string) => `${TEMPO_EXPLORER}/tx/${hash}`);

  const balanceOf = async (owner: Address) =>
    (await rl(() => client.token.getBalance({ account: owner, token }))).amount;

  const receiptOf = (hash: Hex) =>
    rl(() => client.getTransactionReceipt({ hash })).catch((e: unknown) => {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    });
  /** The chain's time, from its newest block, in seconds. */
  const chainTime = async () => (await rl(() => client.getBlock({ blockTag: "latest" }))).timestamp;

  /**
   * Signs the calls here, so the transaction's hash is known before anything goes out, then sends it and waits
   * for its receipt. Before the send nothing can have moved, so errors there are plain failures. After it the
   * only answers are the receipt, or the chain's head passing the transaction's expiry with no receipt (it
   * never landed). Without either, it may still land: TransferUnconfirmedError, never a failure.
   */
  async function sendAndConfirm(from: typeof treasury, calls: { to: Address; data: Hex }[]) {
    const feePayer = from === treasury ? undefined : treasury;
    const validBefore = Math.floor(Date.now() / 1000) + VALID_FOR_S;
    const request = await rl(() => client.prepareTransactionRequest({ account: from, feePayer, calls, nonceKey: "expiring", validBefore }));
    // The expiry is what lets a missing receipt mean "never landed". Never send without the one asked for.
    if (request.validBefore !== validBefore) throw new Error("tempo tx was prepared without its expiry; not sent");
    const raw = await client.signTransaction({ ...request, chain: client.chain });
    const hash = keccak256(raw);
    let lastError: unknown = null;
    try {
      await rl(() => client.sendRawTransaction({ serializedTransaction: raw }));
    } catch (e) {
      // Even a refusal could come from a node that passed it on, so it's only known once the chain answers.
      lastError = e;
    }
    /** The receipt; "expired" once the chain's head is past the transaction's expiry and it still isn't there; else null. */
    const look = async () => {
      const receipt = await receiptOf(hash);
      if (receipt) return receipt;
      if ((await chainTime()) <= BigInt(validBefore + EXPIRY_MARGIN_S)) return null;
      // Asked again after the head: a receipt query answered by a node that lags the one with the head can't count as "never".
      return (await receiptOf(hash)) ?? "expired";
    };
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      const seen = await look().catch((e: unknown) => {
        lastError = e;
        return null;
      });
      if (seen === "expired") throw new Error(`tempo tx ${hash} expired without landing`);
      if (seen) return { hash, receipt: seen };
      await sleep(1000);
    }
    throw new TransferUnconfirmedError("tempo", hash, lastError ?? new Error("not confirmed in time"));
  }

  /**
   * The legs a successful transaction kept from their recipients, by index (see deliveredTo). `from` is the
   * sender when we know it; asked about later we don't, and every call in the transaction is ours anyway.
   */
  const heldBackIn = (logs: readonly Log[], legs: readonly Pick<TransferLeg, "to" | "amount">[], from?: Address) =>
    legs.flatMap((leg, i) => (deliveredTo(logs, { token, from, to: leg.to as Address, amount: leg.amount }) ? [] : [i]));

  /**
   * Every leg in one sponsored transaction: all of them land, or none do. A leg a receive policy blocked still
   * lands, in the network's hands rather than its recipient's: HeldBackError says which, so the rest count as paid.
   */
  async function transferBatch(from: typeof treasury, legs: readonly TransferLeg[]): Promise<SettleResult> {
    if (legs.length === 0 || legs.length > MAX_BATCH_LEGS) throw new Error(`a batch carries 1 to ${MAX_BATCH_LEGS} legs`);
    const { hash, receipt } = await sendAndConfirm(from, batchCalls(token, legs));
    if (receipt.status !== "success") throw new Error(`tempo tx ${hash} reverted`);
    const result = { txHash: hash, explorerUrl: explorerTx(hash) };
    const heldBack = heldBackIn(receipt.logs, legs, from.address);
    if (heldBack.length > 0) throw new HeldBackError(result, heldBack, heldBack.map((i) => legs[i]?.to ?? ""));
    return result;
  }

  const transfer = (from: typeof treasury, to: Address, amount: bigint, memo: string) => transferBatch(from, [{ to, amount, memo }]);

  /** The treasury pays its own fee in AlphaUSD too, so keep a dollar of headroom. */
  async function ensureTreasury(amount: bigint): Promise<void> {
    if (!cfg.faucet || (await balanceOf(treasury.address)) >= amount + 1_000_000n) return;
    await rl(() => client.faucet.fundSync({ account: treasury.address, timeout: 30_000 }));
  }

  return {
    chain: "tempo",
    tokenId: token,
    isValidAddress: (a) => isAddress(a, { strict: false }),
    async createWallet() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      return { address: Account.fromSecp256k1(bytesToHex(secret)).address, secret };
    },
    getBalance: (owner) => balanceOf(owner as Address),
    // Nothing to close on Tempo: an escrow drained by a sponsored transfer is left at exactly zero.
    async settle({ fromSecret, to, amount, memo }) {
      return transfer(Account.fromSecp256k1(bytesToHex(fromSecret)), to as Address, amount, memo);
    },
    // Tempo transactions carry a list of calls run atomically: a split pays everyone in one transaction, or nobody.
    batch: {
      maxLegs: MAX_BATCH_LEGS,
      settleBatch: ({ fromSecret, legs }) => transferBatch(Account.fromSecp256k1(bytesToHex(fromSecret)), legs),
    },
    // Landed is a receipt that succeeded; reverted is failed. A leg it didn't deliver is reported, not hidden.
    async transferOutcome(txHash, { sentAt, now }, legs = []) {
      const receipt = await receiptOf(txHash as Hex);
      if (receipt) {
        if (receipt.status !== "success") return { state: "failed" };
        const heldBack = heldBackIn(receipt.logs, legs);
        return { state: "landed", result: { txHash, explorerUrl: explorerTx(txHash) }, ...(heldBack.length ? { heldBack } : {}) };
      }
      // Never known to the chain, long past its expiry by our clock and by the chain's own: it never landed.
      const deadline = sentAt.getTime() + NEVER_LANDS_AFTER_MS;
      if (now.getTime() <= deadline || Number(await chainTime()) * 1000 <= deadline) return { state: "pending" };
      return (await receiptOf(txHash as Hex)) ? { state: "pending" } : { state: "failed" };
    },
    async treasuryAddress() {
      return treasury.address;
    },
    async fund(to, amount) {
      await ensureTreasury(amount);
      return transfer(treasury, to as Address, amount, "fund");
    },
  };
}

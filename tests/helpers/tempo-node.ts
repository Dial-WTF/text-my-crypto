import { type Address, decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex, keccak256, numberToHex } from "viem";
import { tempoModerato } from "viem/chains";
import { Abis, Transaction } from "viem/tempo";
import { vi } from "vitest";

/** One JSON-RPC answer: a result, a JSON-RPC error, or an HTTP status with no body. */
type Answer = { result: unknown } | { error: { code: number; message: string } } | { http: number };

/** A transaction the fake node was handed, decoded from the raw bytes the adapter signed. */
type SentTx = {
  raw: Hex;
  hash: Hex;
  from: Address;
  sponsored: boolean;
  nonceKey: bigint | undefined;
  validBefore: number | undefined;
  /** One per call: the token called, and its transferWithMemo arguments. */
  legs: Array<{ token: Address; to: Address; amount: bigint; memo: Hex }>;
};

/** Where a receive policy sends a blocked transfer instead of its recipient. */
export const GUARD: Address = "0x9999999999999999999999999999999999999999";

export type FakeTempoNode = {
  /** Every RPC call, by method. */
  methods: string[];
  /** Every transaction handed to eth_sendRawTransaction, answered or not. */
  sent: SentTx[];
  /** What the chain has mined, by hash. A hash missing here has no receipt yet. */
  mined: Map<Hex, { status: "0x1" | "0x0"; from: Address; logs: unknown[] }>;
  /** The head block's timestamp, in seconds. Starts at the real clock. */
  chainTime: number;
  /** Recipients whose receive policy blocks transfers: their legs land in GUARD. */
  blocked: Set<string>;
  /** The node's answer to eth_sendRawTransaction. Default: accepts it and returns its hash. */
  onSend: (tx: SentTx) => Answer;
  /** Whether an accepted (or lost-in-transit) transaction gets mined. Default true. */
  mines: (tx: SentTx) => boolean;
  /** Overrides eth_getTransactionReceipt (an HTTP error, say). Unset, or returning null: answer from `mined`. */
  onReceipt: ((hash: Hex) => Answer | null) | null;
  /** Overrides eth_estimateGas. Null: a fixed estimate. */
  onEstimate: (() => Answer) | null;
  /** Runs before each answer, so a test can move the chain's clock as the adapter polls. */
  tick: (method: string) => void;
};

/** A Transfer event log in RPC form. */
export function rpcTransferLog(token: Address, from: Address, to: Address, amount: bigint, txHash: Hex) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: Abis.tip20, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockHash: `0x${"bb".repeat(32)}`,
    blockNumber: "0x10",
    logIndex: "0x0",
    transactionHash: txHash,
    transactionIndex: "0x0",
    removed: false,
  };
}

/**
 * A fake Tempo Moderato node behind global fetch. It decodes what the adapter signs, mines it (a Transfer log per
 * leg, or one to GUARD for a blocked recipient), and serves receipts and the head block from that.
 */
export function fakeTempoNode(): FakeTempoNode {
  const node: FakeTempoNode = {
    methods: [],
    sent: [],
    mined: new Map(),
    chainTime: Math.floor(Date.now() / 1000),
    blocked: new Set(),
    onSend: (tx) => ({ result: tx.hash }),
    mines: () => true,
    onReceipt: null,
    onEstimate: null,
    tick: () => {},
  };

  const mine = (tx: SentTx) => {
    if (!node.mines(tx)) return;
    const logs = tx.legs.map((leg, i) => ({
      ...rpcTransferLog(leg.token, tx.from, node.blocked.has(leg.to.toLowerCase()) ? GUARD : leg.to, leg.amount, tx.hash),
      logIndex: numberToHex(i),
    }));
    node.mined.set(tx.hash, { status: "0x1", from: tx.from, logs });
  };

  const receipt = (hash: Hex): Answer => {
    const m = node.mined.get(hash);
    if (!m) return { result: null };
    return {
      result: {
        blockHash: `0x${"bb".repeat(32)}`,
        blockNumber: "0x10",
        contractAddress: null,
        cumulativeGasUsed: "0x1",
        effectiveGasPrice: "0x1",
        from: m.from,
        gasUsed: "0x1",
        logs: m.logs,
        logsBloom: `0x${"00".repeat(256)}`,
        status: m.status,
        to: m.from,
        transactionHash: hash,
        transactionIndex: "0x0",
        type: "0x76",
      },
    };
  };

  const answer = (method: string, params: unknown[]): Answer => {
    switch (method) {
      case "eth_chainId":
        return { result: numberToHex(tempoModerato.id) };
      case "eth_fillTransaction":
        return { result: null };
      case "eth_estimateGas":
        return node.onEstimate?.() ?? { result: "0x30000" };
      case "eth_maxPriorityFeePerGas":
        return { result: "0x1" };
      case "eth_getBlockByNumber":
        return {
          result: { baseFeePerGas: "0x1", number: "0x10", timestamp: numberToHex(node.chainTime), hash: `0x${"bb".repeat(32)}`, transactions: [] },
        };
      case "eth_sendRawTransaction": {
        const tx = decode(params[0] as Hex);
        node.sent.push(tx);
        const a = node.onSend(tx);
        // A send whose answer was lost (an HTTP error) may still have reached the chain.
        if (!("error" in a)) mine(tx);
        return a;
      }
      case "eth_getTransactionReceipt":
        return node.onReceipt?.(params[0] as Hex) ?? receipt(params[0] as Hex);
      default:
        return { error: { code: -32601, message: `unexpected ${method}` } };
    }
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      node.methods.push(req.method);
      node.tick(req.method);
      const a = answer(req.method, req.params);
      if ("http" in a) return new Response("unavailable", { status: a.http });
      return Response.json({ jsonrpc: "2.0", id: req.id, ...a });
    }),
  );
  return node;
}

function decode(raw: Hex): SentTx {
  const tx = Transaction.deserialize(raw as Transaction.TransactionSerializedTempo);
  const legs = tx.calls.map((c) => {
    const { args } = decodeFunctionData({ abi: Abis.tip20, data: c.data ?? "0x" });
    return { token: c.to as Address, to: args[0] as Address, amount: args[1] as bigint, memo: args[2] as Hex };
  });
  return {
    raw,
    hash: keccak256(raw),
    from: (tx as { from?: Address }).from as Address,
    sponsored: Boolean(tx.feePayerSignature),
    nonceKey: tx.nonceKey,
    validBefore: tx.validBefore,
    legs,
  };
}

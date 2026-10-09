import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex, hexToString, type Log } from "viem";
import { Abis } from "viem/tempo";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchLeg } from "@/lib/settlement/types";

type SentTx = { account: { address: Hex }; feePayer?: { address: Hex }; calls: Array<{ to: Hex; data: Hex }> };
const sent: SentTx[] = [];
let receiptFor: (tx: SentTx) => { status: "success" | "reverted"; transactionHash: Hex; logs: Log[] };

// The adapter's Tempo client, with the RPC replaced: it records each transaction instead of sending it.
vi.mock("viem/tempo", async (importOriginal) => {
  const real = await importOriginal<typeof import("viem/tempo")>();
  return {
    ...real,
    createClient: (opts: Parameters<typeof real.createClient>[0]) => ({
      ...real.createClient(opts),
      sendTransactionSync: async (tx: SentTx) => {
        sent.push(tx);
        return receiptFor(tx);
      },
    }),
  };
});

const { ALPHA_USD, batchCalls, createTempoAdapter } = await import("@/lib/settlement/tempo");

function transferLog(from: Hex, to: Hex, amount: bigint): Log {
  return {
    address: ALPHA_USD,
    topics: encodeEventTopics({ abi: Abis.tip20, eventName: "Transfer", args: { from, to } }) as Log["topics"],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  };
}

/** A receipt where every call delivered what it said. */
const delivered = (tx: SentTx) => ({
  status: "success" as const,
  transactionHash: "0xbatch" as Hex,
  logs: tx.calls.map((c) => {
    const { args } = decodeFunctionData({ abi: Abis.tip20, data: c.data });
    return transferLog(tx.account.address, args[0] as Hex, args[1] as bigint);
  }),
});

const legs: BatchLeg[] = [
  { to: "0x1111111111111111111111111111111111111111", amount: 3_340_000n, memo: "pi_leg_aaaaaaaaaaaa" },
  { to: "0x2222222222222222222222222222222222222222", amount: 3_330_000n, memo: "pi_leg_bbbbbbbbbbbb" },
  { to: "0x3333333333333333333333333333333333333333", amount: 3_330_000n, memo: "pi_leg_cccccccccccc" },
];

beforeEach(() => {
  sent.length = 0;
  receiptFor = delivered;
});

describe("tempo batch settlement", () => {
  const treasuryKey = `0x${"11".repeat(32)}` as const;
  const adapter = createTempoAdapter({ treasuryKey });
  const fromSecret = new Uint8Array(32).fill(7);

  it("sends one transaction with a transferWithMemo call per leg, sponsored by the treasury", async () => {
    const r = await adapter.settleBatch!({ fromSecret, legs });
    expect(r).toEqual({ txHash: "0xbatch", explorerUrl: "https://explore.testnet.tempo.xyz/tx/0xbatch" });
    expect(sent).toHaveLength(1);
    const [tx] = sent;
    expect(tx!.feePayer?.address).toBe(await adapter.treasuryAddress());
    expect(tx!.account.address).not.toBe(tx!.feePayer?.address);
    expect(tx!.calls).toHaveLength(3);
    for (const [i, call] of tx!.calls.entries()) {
      expect(call.to).toBe(ALPHA_USD);
      const { functionName, args } = decodeFunctionData({ abi: Abis.tip20, data: call.data });
      expect(functionName).toBe("transferWithMemo");
      expect(args[0]).toBe(legs[i]!.to);
      expect(args[1]).toBe(legs[i]!.amount);
      expect(hexToString(args[2] as Hex, { size: 32 })).toBe(legs[i]!.memo);
    }
  });

  it("matches batchCalls exactly", () => {
    expect(batchCalls(ALPHA_USD, legs)).toHaveLength(3);
  });

  it("throws when the transaction reverts, so no leg is recorded as paid", async () => {
    receiptFor = () => ({ status: "reverted", transactionHash: "0xbad", logs: [] });
    await expect(adapter.settleBatch!({ fromSecret, legs })).rejects.toThrow("tempo tx 0xbad reverted");
  });

  it("throws when a leg's transfer isn't in the receipt", async () => {
    receiptFor = (tx) => {
      const r = delivered(tx);
      return { ...r, logs: r.logs.slice(0, 2) };
    };
    await expect(adapter.settleBatch!({ fromSecret, legs })).rejects.toThrow(/did not deliver to 0x3333/);
  });

  it("refuses an empty batch and one too big to send", async () => {
    await expect(adapter.settleBatch!({ fromSecret, legs: [] })).rejects.toThrow();
    const many = Array.from({ length: 17 }, () => legs[0]!);
    await expect(adapter.settleBatch!({ fromSecret, legs: many })).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

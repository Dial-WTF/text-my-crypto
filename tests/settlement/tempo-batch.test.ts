import { bytesToHex, type Hex, hexToString, maxUint256 } from "viem";
import { Account } from "viem/tempo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferLeg as BatchLeg } from "@/lib/settlement/capabilities";
import { ALPHA_USD, batchCalls, createTempoAdapter } from "@/lib/settlement/tempo";
import { HeldBackError } from "@/lib/settlement/types";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { type FakeTempoNode, fakeTempoNode } from "../helpers/tempo-node";

const legs: BatchLeg[] = [
  { to: "0x1111111111111111111111111111111111111111", amount: 3_340_000n, memo: "pi_leg_aaaaaaaaaaaa" },
  { to: "0x2222222222222222222222222222222222222222", amount: 3_330_000n, memo: "pi_leg_bbbbbbbbbbbb" },
  { to: "0x3333333333333333333333333333333333333333", amount: 3_330_000n, memo: "pi_leg_cccccccccccc" },
];

let node: FakeTempoNode;
beforeEach(() => {
  node = fakeTempoNode();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tempo batch settlement", () => {
  const treasuryKey = `0x${"11".repeat(32)}` as const;
  const adapter = createTempoAdapter({ treasuryKey, rpcUrl: "https://tempo.test" });
  const fromSecret = new Uint8Array(32).fill(7);
  const payer = Account.fromSecp256k1(bytesToHex(fromSecret)).address;

  it("sends one transaction with a transferWithMemo call per leg, sponsored by the treasury", async () => {
    const r = await adapter.batch!.settleBatch({ fromSecret, legs });
    expect(node.sent).toHaveLength(1);
    const [tx] = node.sent;
    expect(r).toEqual({ txHash: tx!.hash, explorerUrl: `https://explore.testnet.tempo.xyz/tx/${tx!.hash}` });
    expect(tx!.from.toLowerCase()).toBe(payer.toLowerCase());
    expect(tx!.sponsored).toBe(true);
    expect(tx!.legs).toHaveLength(3);
    for (const [i, leg] of tx!.legs.entries()) {
      expect(leg.token).toBe(ALPHA_USD);
      expect(leg.to.toLowerCase()).toBe(legs[i]!.to);
      expect(leg.amount).toBe(legs[i]!.amount);
      expect(hexToString(leg.memo, { size: 32 })).toBe(legs[i]!.memo);
    }
  });

  it("signs here, on an expiring nonce that lapses 25 seconds after signing", async () => {
    const before = Math.floor(Date.now() / 1000);
    await adapter.batch!.settleBatch({ fromSecret, legs });
    const [tx] = node.sent;
    expect(tx!.nonceKey).toBe(maxUint256);
    expect(tx!.validBefore).toBeGreaterThanOrEqual(before + 25);
    expect(tx!.validBefore).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 25);
  });

  it("matches batchCalls exactly", () => {
    expect(batchCalls(ALPHA_USD, legs)).toHaveLength(3);
  });

  it("throws when the transaction reverts, so no leg is recorded as paid", async () => {
    node.mines = () => false;
    node.onSend = (tx) => {
      node.mined.set(tx.hash, { status: "0x0", from: tx.from, logs: [] });
      return { result: tx.hash };
    };
    const err = await adapter.batch!.settleBatch({ fromSecret, legs }).catch((e: unknown) => e);
    expect(err).toEqual(new Error(`tempo tx ${node.sent[0]!.hash} reverted`));
  });

  it("names the legs a receive policy held back, and the transaction that carried the rest", async () => {
    node.blocked.add(legs[2]!.to);
    const err = await adapter.batch!.settleBatch({ fromSecret, legs }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldBackError);
    expect((err as HeldBackError).heldBack).toEqual([2]);
    expect((err as HeldBackError).result.txHash).toBe(node.sent[0]!.hash);
    expect((err as Error).message).toMatch(/did not deliver to 0x3333/);
  });

  it("refuses an empty batch and one too big to send", async () => {
    await expect(adapter.batch!.settleBatch({ fromSecret, legs: [] })).rejects.toThrow();
    const many = Array.from({ length: adapter.batch!.maxLegs + 1 }, () => legs[0]!);
    await expect(adapter.batch!.settleBatch({ fromSecret, legs: many })).rejects.toThrow();
    expect(node.sent).toHaveLength(0);
  });

  it("an error before the send is a plain failure: nothing went out", async () => {
    node.onEstimate = () => ({ error: { code: -32000, message: "insufficient funds for gas" } });
    const err = await adapter.batch!.settleBatch({ fromSecret, legs }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransferUnconfirmedError);
    expect(node.sent).toHaveLength(0);
  });
});

describe("tempo single transfers", () => {
  const treasuryKey = `0x${"11".repeat(32)}` as const;
  const adapter = createTempoAdapter({ treasuryKey, rpcUrl: "https://tempo.test" });
  const to = legs[0]!.to;

  it("a payment is one sponsored call carrying its id as the memo", async () => {
    const r = await adapter.settle({ fromSecret: new Uint8Array(32).fill(9), to, amount: 1_000_000n, memo: "pi_one" });
    const [tx] = node.sent;
    expect(r.txHash).toBe(tx!.hash);
    expect(tx!.sponsored).toBe(true);
    expect(tx!.legs).toEqual([expect.objectContaining({ to: expect.stringMatching(/^0x1111/i), amount: 1_000_000n })]);
    expect(hexToString(tx!.legs[0]!.memo, { size: 32 })).toBe("pi_one");
  });

  it("a drip from the treasury pays its own fee", async () => {
    await adapter.fund(to, 2_000_000n);
    const [tx] = node.sent;
    expect(tx!.sponsored).toBe(false);
    expect(tx!.from.toLowerCase()).toBe((await adapter.treasuryAddress()).toLowerCase());
  });

  it("a payment a receive policy blocked is held back, not delivered", async () => {
    node.blocked.add(to);
    const err = await adapter.settle({ fromSecret: new Uint8Array(32).fill(9), to, amount: 1_000_000n, memo: "pi_one" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeldBackError);
    expect((err as HeldBackError).heldBack).toEqual([0]);
  });

  it("the hash it records is the one the node reports", async () => {
    let reported: Hex | null = null;
    node.onSend = (tx) => {
      reported = tx.hash;
      return { result: tx.hash };
    };
    const r = await adapter.settle({ fromSecret: new Uint8Array(32).fill(9), to, amount: 1n, memo: "pi_one" });
    expect(r.txHash).toBe(reported);
  });
});

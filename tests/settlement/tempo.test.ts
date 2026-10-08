import { encodeAbiParameters, encodeEventTopics, hexToString, type Log, size } from "viem";
import { Abis } from "viem/tempo";
import { describe, expect, it } from "vitest";
import { ALPHA_USD, createTempoAdapter, deliveredTo, encodeMemo } from "@/lib/settlement/tempo";

const alice = "0x1111111111111111111111111111111111111111" as const;
const bob = "0x2222222222222222222222222222222222222222" as const;
const guard = "0x3333333333333333333333333333333333333333" as const;

function transferLog(from: `0x${string}`, to: `0x${string}`, amount: bigint, address = ALPHA_USD): Log {
  return {
    address,
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

describe("tempo memo", () => {
  it("fits a payment id in 32 bytes and reads back as text", () => {
    const memo = encodeMemo("pi_AbCdEfGhIjKlMnOp");
    expect(size(memo)).toBe(32);
    expect(hexToString(memo, { size: 32 })).toBe("pi_AbCdEfGhIjKlMnOp");
  });

  it("hashes memos longer than 32 bytes instead of truncating them", () => {
    const long = "x".repeat(40);
    expect(size(encodeMemo(long))).toBe(32);
    expect(encodeMemo(long)).not.toBe(encodeMemo(`${long}y`));
  });
});

describe("tempo delivery check", () => {
  const expected = { token: ALPHA_USD, from: alice, to: bob, amount: 1_000_000n };

  it("accepts a Transfer to the intended recipient", () => {
    expect(deliveredTo([transferLog(alice, bob, 1_000_000n)], expected)).toBe(true);
  });

  it("matches addresses regardless of checksum casing", () => {
    expect(deliveredTo([transferLog(alice, bob, 1_000_000n)], { ...expected, to: bob.toUpperCase().replace("0X", "0x") as `0x${string}` })).toBe(true);
  });

  it("rejects a transfer that landed in the receive-policy guard", () => {
    expect(deliveredTo([transferLog(alice, guard, 1_000_000n)], expected)).toBe(false);
  });

  it("rejects a wrong amount, sender or token", () => {
    expect(deliveredTo([transferLog(alice, bob, 999_999n)], expected)).toBe(false);
    expect(deliveredTo([transferLog(guard, bob, 1_000_000n)], expected)).toBe(false);
    expect(deliveredTo([transferLog(alice, bob, 1_000_000n, guard)], expected)).toBe(false);
  });

  it("rejects receipts with no Transfer event", () => {
    expect(deliveredTo([], expected)).toBe(false);
  });
});

describe("tempo adapter (offline)", () => {
  const adapter = createTempoAdapter({ treasuryKey: `0x${"11".repeat(32)}` });

  it("validates EVM addresses", () => {
    expect(adapter.isValidAddress(bob)).toBe(true);
    expect(adapter.isValidAddress("0x123")).toBe(false);
    expect(adapter.isValidAddress("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")).toBe(false);
  });

  it("creates server-held wallets with 32-byte secrets", async () => {
    const w = await adapter.createWallet();
    expect(w.secret).toHaveLength(32);
    expect(adapter.isValidAddress(w.address)).toBe(true);
    expect(adapter.chain).toBe("tempo");
    expect(adapter.tokenId).toBe(ALPHA_USD);
  });
});

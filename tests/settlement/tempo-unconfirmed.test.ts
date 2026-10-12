import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALPHA_USD, createTempoAdapter } from "@/lib/settlement/tempo";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { type FakeTempoNode, fakeTempoNode, GUARD, rpcTransferLog } from "../helpers/tempo-node";

/** Runs fake time forward a second at a time, letting real async work (signing, fetch) happen in between, until `p` settles. */
async function runUntilSettled<T>(p: Promise<T>, maxMs: number): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => {});
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `done` flips in the .finally callback above
  for (let t = 0; t < maxMs && !done; t += 1000) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1000);
  }
  return p;
}

const TO: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";

let node: FakeTempoNode;
let tempo: SettlementAdapter;
const settle = () => tempo.settle({ fromSecret: new Uint8Array(32).fill(5), to: TO, amount: 1_000_000n, memo: "pi_tempo" });
/** Moves the chain's clock on by `s` seconds every time the adapter reads the head block. */
const chainAdvances = (s: number) => {
  node.tick = (method) => {
    if (method === "eth_getBlockByNumber") node.chainTime += s;
  };
};

beforeEach(() => {
  node = fakeTempoNode();
  tempo = createTempoAdapter({ treasuryKey: `0x${"11".repeat(32)}`, rpcUrl: "https://tempo.test", explorerTx: (h) => `https://tempo.test/tx/${h}` });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Tempo sends that go out without an answer", () => {
  it("a send whose answer was lost but reached the chain is found by its hash and counts as paid", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    node.onSend = () => ({ http: 503 });
    const r = await runUntilSettled(settle(), 10_000);
    expect(r.txHash).toBe(node.sent[0]!.hash);
  });

  it("a send that never reached the chain fails once the chain is past its expiry: nothing moved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    node.onSend = () => ({ http: 503 });
    node.mines = () => false;
    chainAdvances(5);
    const err = await runUntilSettled(settle().catch((e: unknown) => e), 120_000);
    expect(err).not.toBeInstanceOf(TransferUnconfirmedError);
    expect((err as Error).message).toBe(`tempo tx ${node.sent[0]!.hash} expired without landing`);
  });

  it("a send the node refused is only called failed once it can't land either", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    node.onSend = () => ({ error: { code: -32000, message: "nonce too low" } });
    chainAdvances(5);
    const err = await runUntilSettled(settle().catch((e: unknown) => e), 120_000);
    expect((err as Error).message).toMatch(/expired without landing/);
    expect(err).not.toBeInstanceOf(TransferUnconfirmedError);
  });

  it("an RPC that stops answering after the send leaves it unconfirmed with its hash, never failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    node.onReceipt = () => ({ http: 502 });
    const err = await runUntilSettled(settle().catch((e: unknown) => e), 200_000);
    expect(err).toBeInstanceOf(TransferUnconfirmedError);
    expect((err as TransferUnconfirmedError).txHash).toBe(node.sent[0]!.hash);
  });

  it("rides out an RPC that drops for a few seconds and returns the transaction once it answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let reads = 0;
    node.onReceipt = () => (++reads <= 3 ? { http: 502 } : null);
    const r = await runUntilSettled(settle(), 30_000);
    expect(r.txHash).toBe(node.sent[0]!.hash);
    expect(reads).toBe(4);
  });

  it("a receipt a lagging node missed is asked for again before the send is called expired", async () => {
    node.chainTime += 3600;
    let reads = 0;
    node.onReceipt = () => (++reads === 1 ? { result: null } : null);
    const r = await settle();
    expect(r.txHash).toBe(node.sent[0]!.hash);
    expect(reads).toBe(2);
  });
});

describe("Tempo transfers asked about later", () => {
  const sentAt = new Date("2026-10-09T12:00:00Z");
  const at = (min: number) => ({ sentAt, now: new Date(sentAt.getTime() + min * 60_000) });
  const HASH: Hex = `0x${"ab".repeat(32)}`;
  const FROM: Address = "0x5555555555555555555555555555555555555555";
  const legs = [
    { to: TO, amount: 1_000_000n },
    { to: OTHER, amount: 2_000_000n },
  ];
  const mined = (status: "0x1" | "0x0", toSecond: Address = OTHER) =>
    node.mined.set(HASH, {
      status,
      // Whoever the receipt names as sender (the fee payer, say), delivery is read from the Transfer logs.
      from: "0x7777777777777777777777777777777777777777",
      logs: [rpcTransferLog(ALPHA_USD, FROM, TO, 1_000_000n, HASH), rpcTransferLog(ALPHA_USD, FROM, toSecond, 2_000_000n, HASH)],
    });

  it("landed, with every leg delivered", async () => {
    mined("0x1");
    expect(await tempo.transferOutcome!(HASH, at(1), legs)).toEqual({ state: "landed", result: { txHash: HASH, explorerUrl: `https://tempo.test/tx/${HASH}` } });
    expect(await tempo.transferOutcome!(HASH, at(1))).toEqual({ state: "landed", result: { txHash: HASH, explorerUrl: `https://tempo.test/tx/${HASH}` } });
  });

  it("landed, naming a leg a receive policy held back", async () => {
    mined("0x1", GUARD);
    expect(await tempo.transferOutcome!(HASH, at(1), legs)).toEqual({
      state: "landed",
      result: { txHash: HASH, explorerUrl: `https://tempo.test/tx/${HASH}` },
      heldBack: [1],
    });
  });

  it("reverted is failed", async () => {
    mined("0x0");
    expect(await tempo.transferOutcome!(HASH, at(1), legs)).toEqual({ state: "failed" });
  });

  it("unknown to the chain: pending until it's long past its expiry by our clock and the chain's", async () => {
    node.chainTime = Math.floor(sentAt.getTime() / 1000) + 120;
    expect(await tempo.transferOutcome!(HASH, at(2), legs)).toEqual({ state: "pending" });
    // Our clock is past the cutoff, but the node's head isn't: it may be behind, so wait.
    expect(await tempo.transferOutcome!(HASH, at(11), legs)).toEqual({ state: "pending" });
    node.chainTime = Math.floor(sentAt.getTime() / 1000) + 11 * 60;
    expect(await tempo.transferOutcome!(HASH, at(11), legs)).toEqual({ state: "failed" });
  });

  it("found on the second look, after the head, it's pending rather than failed", async () => {
    node.chainTime = Math.floor(sentAt.getTime() / 1000) + 11 * 60;
    let reads = 0;
    node.onReceipt = () => (++reads === 1 ? { result: null } : null);
    mined("0x1");
    expect(await tempo.transferOutcome!(HASH, at(11), legs)).toEqual({ state: "pending" });
  });

  it("an RPC that won't answer is an error to try again, not an outcome", async () => {
    node.onReceipt = () => ({ http: 503 });
    await expect(tempo.transferOutcome!(HASH, at(90), legs)).rejects.toThrow();
  });
});

import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import { createEvmAdapter } from "@/lib/settlement/evm";
import { createSolanaAdapter } from "@/lib/settlement/solana";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";

type Rpc = { method: string; params: unknown[] };
/** One JSON-RPC method's answer: a result, a JSON-RPC error, or an HTTP status with no body. */
type Answer = { result: unknown } | { error: { code: number; message: string; data?: unknown } } | { http: number };

/** A fake JSON-RPC node behind global fetch. `answer` decides each call; every call is recorded. */
function fakeNode(answer: (rpc: Rpc) => Answer) {
  const calls: Rpc[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      calls.push({ method: req.method, params: req.params });
      const a = answer(req);
      if ("http" in a) return new Response("unavailable", { status: a.http });
      return Response.json({ jsonrpc: "2.0", id: req.id, ...a });
    }),
  );
  return calls;
}

/** Runs fake time forward a second at a time, letting real async work (signing, fetch) happen in between, until `p` settles. */
async function runUntilSettled<T>(p: Promise<T>, maxMs: number): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => {});
  for (let t = 0; t < maxMs && !done; t += 1000) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1000);
  }
  return p;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("Solana sends that go out without an answer", () => {
  let sol: SettlementAdapter;
  let to: string;
  const statuses: { next: () => Answer } = { next: () => ({ result: { context: { slot: 1 }, value: [null] } }) };
  const settle = () => sol.settle({ fromSecret: crypto.getRandomValues(new Uint8Array(32)), to, amount: 1_000_000n, memo: "pi_test" });

  beforeEach(async () => {
    sol = createSolanaAdapter({
      rpcUrl: "https://solana.test",
      mint: MINT,
      explorerTx: (sig) => `https://explorer.test/${sig}`,
      treasurySeed: crypto.getRandomValues(new Uint8Array(32)),
    });
    to = (await generateKeyPairSigner()).address;
  });

  const node = (send: Answer) =>
    fakeNode(({ method }) => {
      if (method === "getLatestBlockhash") return { result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } } };
      if (method === "sendTransaction") return send;
      if (method === "getSignatureStatuses") return statuses.next();
      if (method === "getBlockHeight") return { result: 50 };
      return { error: { code: -32601, message: `unexpected ${method}` } };
    });

  it("a send the node may have taken (an HTTP error) is unconfirmed with its signature, not failed", async () => {
    node({ http: 503 });
    const err = await settle().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransferUnconfirmedError);
    expect((err as TransferUnconfirmedError).txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });

  it("a send the simulation refused never went out: that's a plain failure", async () => {
    const data = { accounts: null, err: "AccountNotFound", logs: [], unitsConsumed: 0, returnData: null, innerInstructions: null, replacementBlockhash: null, loadedAccountsDataSize: 0 };
    node({ error: { code: -32002, message: "Transaction simulation failed", data } });
    const err = await settle().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransferUnconfirmedError);
  });

  it("rides out an RPC that stops answering while it waits, and returns the transaction once it confirms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let n = 0;
    statuses.next = () => (++n < 4 ? { http: 502 } : { result: { context: { slot: 2 }, value: [{ confirmationStatus: "confirmed", err: null, slot: 2, confirmations: 1 }] } });
    node({ result: "sig" });
    await expect(runUntilSettled(settle(), 30_000)).resolves.toMatchObject({ txHash: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/) });
  });

  it("an RPC that never answers again leaves it unconfirmed, never failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    statuses.next = () => ({ http: 502 });
    node({ result: "sig" });
    expect(await runUntilSettled(settle().catch((e: unknown) => e), 200_000)).toBeInstanceOf(TransferUnconfirmedError);
  });

  it("asks the chain later: landed, failed on chain, still able to land, or long past its blockhash", async () => {
    const sentAt = new Date("2026-10-09T12:00:00Z");
    const at = (min: number) => ({ sentAt, now: new Date(sentAt.getTime() + min * 60_000) });
    const answer = (value: unknown) => fakeNode(() => ({ result: { context: { slot: 9 }, value: [value] } }));

    const calls = answer({ confirmationStatus: "finalized", err: null, slot: 9, confirmations: null });
    expect(await sol.transferOutcome!("sigA", at(1))).toEqual({ state: "landed", result: { txHash: "sigA", explorerUrl: "https://explorer.test/sigA" } });
    expect(calls[0]).toMatchObject({ method: "getSignatureStatuses", params: [["sigA"], { searchTransactionHistory: true }] });

    answer({ confirmationStatus: "confirmed", err: { InstructionError: [1, "Custom"] }, slot: 9, confirmations: 1 });
    expect(await sol.transferOutcome!("sigA", at(1))).toEqual({ state: "failed" });

    answer(null);
    expect(await sol.transferOutcome!("sigA", at(2))).toEqual({ state: "pending" });
    expect(await sol.transferOutcome!("sigA", at(16))).toEqual({ state: "failed" });
  });
});

describe("EVM transfers asked about later", () => {
  const evm = () =>
    createEvmAdapter({
      chain: "base",
      viem: baseSepolia,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      explorerTx: (h) => `https://basescan.test/tx/${h}`,
      treasuryKey: `0x${"11".repeat(32)}`,
      rpcUrl: "https://base.test",
    });
  const HASH = `0x${"ab".repeat(32)}`;
  const receipt = (status: "0x1" | "0x0") => ({
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: "0x10",
    contractAddress: null,
    cumulativeGasUsed: "0x1",
    effectiveGasPrice: "0x1",
    from: `0x${"01".repeat(20)}`,
    gasUsed: "0x1",
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    to: `0x${"02".repeat(20)}`,
    transactionHash: HASH,
    transactionIndex: "0x0",
    type: "0x2",
  });
  const sentAt = new Date("2026-10-09T12:00:00Z");
  const at = (min: number) => ({ sentAt, now: new Date(sentAt.getTime() + min * 60_000) });

  it("landed, reverted, still in flight, or past its authorization's hour", async () => {
    fakeNode(() => ({ result: receipt("0x1") }));
    expect(await evm().transferOutcome!(HASH, at(1))).toEqual({ state: "landed", result: { txHash: HASH, explorerUrl: `https://basescan.test/tx/${HASH}` } });
    fakeNode(() => ({ result: receipt("0x0") }));
    expect(await evm().transferOutcome!(HASH, at(1))).toEqual({ state: "failed" });
    fakeNode(() => ({ result: null }));
    expect(await evm().transferOutcome!(HASH, at(30))).toEqual({ state: "pending" });
    expect(await evm().transferOutcome!(HASH, at(71))).toEqual({ state: "failed" });
  });

  it("an RPC that won't answer is an error to try again, not an outcome", async () => {
    fakeNode(() => ({ http: 503 }));
    await expect(evm().transferOutcome!(HASH, at(90))).rejects.toThrow();
  });
});

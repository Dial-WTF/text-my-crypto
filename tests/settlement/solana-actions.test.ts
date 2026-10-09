import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newReference } from "@/lib/actions/pay";
import type { PaymentActions } from "@/lib/settlement/capabilities";
import { REGISTRY, type SolanaNetwork } from "@/lib/settlement/registry";
import { type ConfirmedTx, createSolanaActions, paidTo } from "@/lib/settlement/solana-actions";

const entry = REGISTRY.solana.testnet as SolanaNetwork;
const RPC_URL = "http://solana-rpc.test";
const BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1EtWTRABZaYq6";
const REFERENCE = newReference();
const ALEX = newReference();
const PAYER = newReference();

type Balance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
type RpcTx = {
  meta: { err: unknown; preTokenBalances?: Balance[] | null; postTokenBalances?: Balance[] | null } | null;
  transaction: { message: { accountKeys: string[] }; signatures: string[] };
};
type Call = { method: string; params: unknown[] };

const bal = (accountIndex: number, owner: string | undefined, amount: number, mint = entry.mint): Balance => ({
  accountIndex,
  mint,
  ...(owner ? { owner } : {}),
  uiTokenAmount: { amount: String(amount) },
});

/** A transfer of `amount` from PAYER's token account (index 1) to `to`'s (index 2). */
const transfer = (amount: number, to = ALEX, err: unknown = null): RpcTx => ({
  meta: {
    err,
    preTokenBalances: [bal(1, PAYER, 9_000_000)],
    postTokenBalances: [bal(1, PAYER, 9_000_000 - amount), bal(2, to, amount)],
  },
  transaction: { message: { accountKeys: [PAYER] }, signatures: [] },
});

/**
 * A Solana JSON-RPC node over a stubbed fetch: signatures for the reference (newest first, as the node
 * returns them) and their transactions. Nothing leaves the process.
 */
function fakeNode() {
  const calls: Call[] = [];
  const state = {
    signatures: [] as Array<{ signature: string; err: unknown }>,
    txs: new Map<string, RpcTx | null>(),
  };
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "getLatestBlockhash":
        return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1234 } };
      case "getSignaturesForAddress":
        return state.signatures.map((s, i) => ({ ...s, slot: 100 - i, memo: null, blockTime: null, confirmationStatus: "confirmed" }));
      case "getTransaction":
        return state.txs.get(String(params[0])) ?? null;
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    expect(url).toBe(RPC_URL);
    const req = JSON.parse(init.body) as { id: number | string; method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: answer(req.method, req.params) }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { calls, state, fetch };
}

let node: ReturnType<typeof fakeNode>;
let actions: PaymentActions;

beforeEach(() => {
  node = fakeNode();
  vi.stubGlobal("fetch", node.fetch);
  actions = createSolanaActions({ rpcUrl: RPC_URL, mint: entry.mint, caip2: entry.caip2, explorerTx: entry.explorerTx });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Solana Actions over RPC", () => {
  it("names its network by CAIP-2 id", () => {
    expect(actions.blockchainId).toBe(entry.caip2);
  });

  it("builds the payment on a fresh confirmed blockhash", async () => {
    const tx = await actions.buildPayment({ payer: PAYER, recipient: ALEX, amount: 5_000_000n, reference: REFERENCE, memo: "ap_1" });
    const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(tx));
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    expect(compiled.lifetimeToken).toBe(BLOCKHASH);
    expect(node.calls).toEqual([{ method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }]);
  });

  it("finds nothing until a payment carrying the reference lands", async () => {
    expect(await actions.findByReference(REFERENCE, ALEX)).toEqual([]);
    expect(node.calls).toEqual([{ method: "getSignaturesForAddress", params: [REFERENCE, { limit: 10, commitment: "confirmed" }] }]);
  });

  it("returns confirmed payments to the recipient oldest first, as from the wallet the money left", async () => {
    // The node lists newest first.
    node.state.signatures = [
      { signature: "SigNew", err: null },
      { signature: "SigOld", err: null },
    ];
    node.state.txs.set("SigOld", transfer(2_000_000));
    node.state.txs.set("SigNew", transfer(3_000_000));
    expect(await actions.findByReference(REFERENCE, ALEX)).toEqual([
      { txHash: "SigOld", explorerUrl: entry.explorerTx("SigOld"), payer: PAYER, amount: 2_000_000n },
      { txHash: "SigNew", explorerUrl: entry.explorerTx("SigNew"), payer: PAYER, amount: 3_000_000n },
    ]);
    const fetched = node.calls.filter((c) => c.method === "getTransaction").map((c) => c.params);
    expect(fetched).toEqual([
      ["SigOld", { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      ["SigNew", { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    ]);
  });

  it("counts nothing that failed, isn't readable yet, paid someone else, or moved no tokens", async () => {
    node.state.signatures = [
      { signature: "SigFailedSig", err: { InstructionError: [1, "Custom"] } },
      { signature: "SigNotYet", err: null },
      { signature: "SigNoMeta", err: null },
      { signature: "SigFailedMeta", err: null },
      { signature: "SigElsewhere", err: null },
      { signature: "SigNoBalances", err: null },
    ];
    node.state.txs.set("SigNotYet", null);
    node.state.txs.set("SigNoMeta", { meta: null, transaction: { message: { accountKeys: [PAYER] }, signatures: [] } });
    node.state.txs.set("SigFailedMeta", transfer(5_000_000, ALEX, { InstructionError: [1, "Custom"] }));
    node.state.txs.set("SigElsewhere", transfer(5_000_000, newReference()));
    node.state.txs.set("SigNoBalances", {
      meta: { err: null, preTokenBalances: null, postTokenBalances: null },
      transaction: { message: { accountKeys: [PAYER] }, signatures: [] },
    });
    expect(await actions.findByReference(REFERENCE, ALEX)).toEqual([]);
    // A signature the node already says failed isn't even fetched.
    expect(node.calls.some((c) => c.method === "getTransaction" && c.params[0] === "SigFailedSig")).toBe(false);
  });

  it("an RPC that is down throws, so the reference is kept for the next pass", async () => {
    node.fetch.mockImplementationOnce(async () => new Response("bad gateway", { status: 502 }));
    await expect(actions.findByReference(REFERENCE, ALEX)).rejects.toThrow();
  });
});

describe("paidTo, who paid", () => {
  const base: ConfirmedTx = { err: null, feePayer: "FeePayer", pre: [], post: [] };

  it("takes the wallet whose balance fell the most, whichever order the rows come in", () => {
    const pre = [bal(1, "Small", 1_000_000), bal(3, "Big", 9_000_000)];
    const post = [bal(1, "Small", 500_000), bal(3, "Big", 4_500_000), bal(2, "Alex", 5_000_000)];
    expect(paidTo({ ...base, pre, post }, entry.mint, "Alex")).toEqual({ received: 5_000_000n, from: "Big" });
    expect(paidTo({ ...base, pre: [...pre].reverse(), post: [...post].reverse() }, entry.mint, "Alex")).toEqual({
      received: 5_000_000n,
      from: "Big",
    });
  });

  it("falls back to the fee payer when no wallet's balance of the mint fell", () => {
    // Minted straight to the recipient: nobody's balance went down.
    expect(paidTo({ ...base, post: [bal(2, "Alex", 5_000_000)] }, entry.mint, "Alex")).toEqual({ received: 5_000_000n, from: "FeePayer" });
  });

  it("falls back to the fee payer when the paying account has no owner on record", () => {
    const tx = { ...base, pre: [bal(1, undefined, 9_000_000)], post: [bal(1, undefined, 4_000_000), bal(2, "Alex", 5_000_000)] };
    expect(paidTo(tx, entry.mint, "Alex")).toEqual({ received: 5_000_000n, from: "FeePayer" });
  });

  it("ignores other mints, and a recipient whose balance fell was not paid", () => {
    const tx = { ...base, pre: [bal(2, "Alex", 5_000_000)], post: [bal(2, "Alex", 1_000_000), bal(5, "Alex", 9_000_000, "OtherMint")] };
    expect(paidTo(tx, entry.mint, "Alex")).toBeNull();
  });
});

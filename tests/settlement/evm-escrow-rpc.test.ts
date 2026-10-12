import {
  type Address,
  decodeFunctionData,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESCROW_ABI, EscrowRefusedError, type EscrowRpc, escrowId, viemEscrowRpc } from "@/lib/settlement/evm-escrow";

/**
 * viemEscrowRpc against a JSON-RPC node faked over a stubbed fetch: no network. The node answers reads
 * from its state, takes signed raw transactions, and refuses a write at gas estimation the way a node
 * does when the contract reverts, with the contract's encoded error.
 */

const RPC_URL = "http://arbitrum-rpc.test";
const CONTRACT = getAddress("0x00000000000000000000000000000000000e5c00");
const TOKEN = getAddress("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
const TREASURY_KEY: Hex = `0x${"11".repeat(32)}`;
const ATTESTOR_KEY: Hex = `0x${"22".repeat(32)}`;
const TREASURY = privateKeyToAccount(TREASURY_KEY).address;
const ATTESTOR = privateKeyToAccount(ATTESTOR_KEY).address;
const SENDER = getAddress("0x00000000000000000000000000000000000a11ce");
const RECIPIENT = getAddress("0x000000000000000000000000000000000000beef");
const ID = escrowId("pi_one");
const R: Hex = `0x${"ab".repeat(32)}`;
const S: Hex = `0x${"cd".repeat(32)}`;

type Sent = { from: Address; to: Address | undefined; value: bigint; fn: string | null; args: readonly unknown[] };
type Log = { event: "Funded" | "Claimed" | "Refunded"; block: bigint; tx: Hex };
type Tuple = readonly [Address, Address, bigint, bigint, number, bigint, bigint];

function fakeNode() {
  const state = {
    escrow: [SENDER, TOKEN, 5_000_000n, 2_000_000_000n, 1, 7n, 0n] as Tuple,
    logs: [] as Log[],
    refuse: null as Hex | null,
    receipts: new Map<Hex, "0x1" | "0x0">(),
    attestorWei: 123n,
    down: false,
  };
  const sent: Sent[] = [];
  const methods: string[] = [];

  const block = {
    number: "0x10",
    hash: `0x${"0".repeat(63)}1`,
    parentHash: `0x${"0".repeat(64)}`,
    timestamp: "0x1",
    baseFeePerGas: "0x5f5e100",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    transactions: [],
  };

  const answer = async (method: string, params: unknown[]): Promise<{ result: unknown } | { error: unknown }> => {
    switch (method) {
      case "eth_chainId":
        return { result: numberToHex(arbitrumSepolia.id) };
      case "eth_call": {
        const { data } = params[0] as { data: Hex };
        const call = decodeFunctionData({ abi: ESCROW_ABI, data });
        if (call.functionName !== "escrow") throw new Error(`unexpected eth_call ${call.functionName}`);
        return { result: encodeFunctionResult({ abi: ESCROW_ABI, functionName: "escrow", result: state.escrow }) };
      }
      case "eth_getLogs": {
        const [filter] = params as [{ address: Address; topics: Array<Hex | null>; fromBlock: Hex; toBlock: Hex }];
        const logs = state.logs
          .filter((l) => numberToHex(l.block) === filter.fromBlock && numberToHex(l.block) === filter.toBlock)
          .map((l) => {
            const topics =
              l.event === "Claimed"
                ? encodeEventTopics({ abi: ESCROW_ABI, eventName: "Claimed", args: { id: ID, to: RECIPIENT } })
                : l.event === "Refunded"
                  ? encodeEventTopics({ abi: ESCROW_ABI, eventName: "Refunded", args: { id: ID, sender: SENDER } })
                  : encodeEventTopics({ abi: ESCROW_ABI, eventName: "Funded", args: { id: ID, sender: SENDER, token: TOKEN } });
            return { topics, l };
          })
          // The node filters by the event's signature and the indexed id, as a real one does.
          .filter(({ topics }) => topics[0] === filter.topics[0] && topics[1] === filter.topics[1])
          .map(({ topics, l }) => ({
            address: CONTRACT,
            topics,
            data: l.event === "Funded" ? `0x${"0".repeat(128)}` : `0x${"0".repeat(64)}`,
            blockNumber: numberToHex(l.block),
            blockHash: block.hash,
            transactionHash: l.tx,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          }));
        return { result: logs };
      }
      case "eth_getBalance":
        return { result: numberToHex(state.attestorWei) };
      case "eth_getTransactionCount":
        return { result: "0x0" };
      case "eth_getBlockByNumber":
        return { result: block };
      case "eth_blockNumber":
        return { result: block.number };
      case "eth_maxPriorityFeePerGas":
        return { result: "0x0" };
      case "eth_gasPrice":
        return { result: "0x5f5e100" };
      case "eth_estimateGas":
        if (state.refuse) {
          const data = state.refuse;
          state.refuse = null;
          return { error: { code: 3, message: "execution reverted", data } };
        }
        return { result: "0x30000" };
      case "eth_sendRawTransaction": {
        const serialized = params[0] as TransactionSerialized;
        const tx = parseTransaction(serialized);
        const from = await recoverTransactionAddress({ serializedTransaction: serialized });
        const call = tx.data ? decodeFunctionData({ abi: ESCROW_ABI, data: tx.data }) : null;
        sent.push({ from, to: tx.to ? getAddress(tx.to) : undefined, value: tx.value ?? 0n, fn: call?.functionName ?? null, args: call?.args ?? [] });
        const hash = keccak256(serialized);
        state.receipts.set(hash, "0x1");
        return { result: hash };
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0] as Hex;
        const status = state.receipts.get(hash);
        if (!status) return { result: null };
        return {
          result: {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: block.hash,
            blockNumber: block.number,
            from: TREASURY,
            to: CONTRACT,
            cumulativeGasUsed: "0x1",
            gasUsed: "0x1",
            effectiveGasPrice: "0x1",
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"0".repeat(512)}`,
            status,
            type: "0x2",
          },
        };
      }
      default:
        // What a node says for a method it doesn't serve (viem tries eth_fillTransaction first).
        return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
    }
  };

  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    expect(new URL(url).origin).toBe(RPC_URL);
    // A rejected RPC key (viem doesn't retry a 401, so the test doesn't wait out backoff).
    if (state.down) return new Response("unauthorized", { status: 401 });
    const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    methods.push(req.method);
    return Response.json({ jsonrpc: "2.0", id: req.id, ...(await answer(req.method, req.params)) });
  });
  return { state, sent, methods, fetch };
}

let node: ReturnType<typeof fakeNode>;
let rpc: EscrowRpc;
const tokenDomain = async () => ({ name: "USD Coin", version: "2" });

beforeEach(() => {
  node = fakeNode();
  vi.stubGlobal("fetch", node.fetch);
  rpc = viemEscrowRpc({
    viem: arbitrumSepolia,
    rpcUrl: RPC_URL,
    contract: CONTRACT,
    treasuryKey: TREASURY_KEY,
    attestorKey: ATTESTOR_KEY,
    token: TOKEN,
    tokenDomain,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const refusal = (errorName: "Expired" | "BadSignature") => encodeErrorResult({ abi: ESCROW_ABI, errorName });
const notOpen = encodeErrorResult({ abi: ESCROW_ABI, errorName: "NotOpen", args: [ID] });

describe("viemEscrowRpc reads", () => {
  it("reads an escrow's status and terms from the contract", async () => {
    expect(await rpc.escrow(ID)).toEqual({
      status: "open",
      sender: SENDER,
      token: TOKEN,
      amount: 5_000_000n,
      expiry: 2_000_000_000n,
      fundedBlock: 7n,
      closedBlock: 0n,
    });
    node.state.escrow = [SENDER, TOKEN, 5_000_000n, 2_000_000_000n, 3, 7n, 9n];
    expect((await rpc.escrow(ID)).status).toBe("refunded");
  });

  it("reads a status it doesn't know as nothing there, never as open", async () => {
    node.state.escrow = [SENDER, TOKEN, 5_000_000n, 2_000_000_000n, 9, 7n, 0n];
    expect((await rpc.escrow(ID)).status).toBe("none");
  });

  it("finds the transaction that emitted an event for this escrow in its block, and nothing elsewhere", async () => {
    const funded: Hex = `0x${"f1".repeat(32)}`;
    const claimed: Hex = `0x${"c1".repeat(32)}`;
    node.state.logs = [
      { event: "Funded", block: 7n, tx: funded },
      { event: "Claimed", block: 9n, tx: claimed },
    ];
    expect(await rpc.eventTx("Funded", ID, 7n)).toBe(funded);
    expect(await rpc.eventTx("Claimed", ID, 9n)).toBe(claimed);
    // Wrong block, wrong event, or another escrow: nothing.
    expect(await rpc.eventTx("Funded", ID, 8n)).toBeNull();
    expect(await rpc.eventTx("Refunded", ID, 9n)).toBeNull();
    expect(await rpc.eventTx("Funded", escrowId("pi_other"), 7n)).toBeNull();
  });

  it("refuses to look up an event the contract doesn't have", async () => {
    await expect(rpc.eventTx("Approval" as "Funded", ID, 7n)).rejects.toThrow("No Approval event in the ABI");
    expect(node.methods).not.toContain("eth_getLogs");
  });

  it("passes the token's domain through and reads the attestor's balance", async () => {
    expect(await rpc.tokenDomain()).toEqual({ name: "USD Coin", version: "2" });
    node.state.attestorWei = 42n;
    expect(await rpc.attestorBalance()).toBe(42n);
  });
});

describe("viemEscrowRpc writes", () => {
  it("the treasury sends the funding with the sender's authorization", async () => {
    const hash = await rpc.fundWithAuthorization({ id: ID, from: SENDER, amount: 5_000_000n, expiry: 2_000_000_000n, validBefore: 99n, v: 27, r: R, s: S });
    expect(node.sent).toEqual([
      { from: TREASURY, to: CONTRACT, value: 0n, fn: "fundWithAuthorization", args: [ID, TOKEN, SENDER, 5_000_000n, 2_000_000_000n, 99n, 27, R, S] },
    ]);
    expect(await rpc.receipt(hash)).toBe("success");
  });

  it("the attestor sends the claim itself; the treasury sends refunds and the attestor's gas", async () => {
    await rpc.claim(ID, RECIPIENT);
    await rpc.refundWithSignature(ID, { v: 28, r: R, s: S });
    await rpc.topUpAttestor(1_000n);
    expect(node.sent).toEqual([
      { from: ATTESTOR, to: CONTRACT, value: 0n, fn: "claim", args: [ID, RECIPIENT] },
      { from: TREASURY, to: CONTRACT, value: 0n, fn: "refundWithSignature", args: [ID, 28, R, S] },
      { from: TREASURY, to: ATTESTOR, value: 1_000n, fn: null, args: [] },
    ]);
  });

  it("names the contract's refusal and sends nothing", async () => {
    node.state.refuse = refusal("Expired");
    const err: unknown = await rpc.claim(ID, RECIPIENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EscrowRefusedError);
    expect(err).toMatchObject({ reason: "Expired" });

    node.state.refuse = notOpen;
    await expect(rpc.refundWithSignature(ID, { v: 27, r: R, s: S })).rejects.toMatchObject({ reason: "NotOpen" });
    node.state.refuse = refusal("BadSignature");
    await expect(
      rpc.fundWithAuthorization({ id: ID, from: SENDER, amount: 1n, expiry: 2n, validBefore: 3n, v: 27, r: R, s: S }),
    ).rejects.toMatchObject({ reason: "BadSignature" });
    expect(node.sent).toEqual([]);
  });

  it("a revert it can't decode isn't named: the error passes through as it came", async () => {
    // NotOpen's selector without its id argument.
    node.state.refuse = notOpen.slice(0, 10) as Hex;
    const err: unknown = await rpc.refundWithSignature(ID, { v: 27, r: R, s: S }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EscrowRefusedError);
    expect(node.sent).toEqual([]);
  });

  it("a node that won't serve us isn't mistaken for the contract refusing", async () => {
    node.state.down = true;
    const err: unknown = await rpc.claim(ID, RECIPIENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EscrowRefusedError);
    expect(node.sent).toEqual([]);
  });

  it("reports a transaction that landed and reverted", async () => {
    const hash = await rpc.claim(ID, RECIPIENT);
    node.state.receipts.set(hash, "0x0");
    expect(await rpc.receipt(hash)).toBe("reverted");
  });
});

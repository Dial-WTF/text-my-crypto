import {
  type Address,
  bytesToHex,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTypedDataAddress,
  serializeSignature,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodTestnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvmAdapter, signPermit } from "@/lib/settlement/evm";
import { REGISTRY } from "@/lib/settlement/registry";
import { guardAdapter, moverFor } from "@/lib/settlement/types";

const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" as const;
const USD = "0x2195e3E09eab088c90B4461B92D06A74d30c1e2e" as const;
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
]);

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const key = (n: number) => new Uint8Array(32).fill(n);
const treasuryKey = bytesToHex(key(7));
const treasury = privateKeyToAccount(treasuryKey).address;
const sender = key(3);
const senderAddress = privateKeyToAccount(bytesToHex(sender)).address;

type Sent = { to: Address | undefined; functionName: string; args: readonly unknown[]; data: Hex };

/** A Robinhood Chain testnet RPC that knows one stock token: 5 TSLA in every wallet, permit nonce 7. */
function fakeRpc() {
  const sent: Sent[] = [];
  const calls: string[] = [];
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "eth_chainId":
        return `0x${robinhoodTestnet.id.toString(16)}`;
      case "eth_call": {
        const { data } = params[0] as { data: Hex };
        const { functionName } = decodeFunctionData({ abi: ABI, data });
        calls.push(functionName);
        if (functionName === "balanceOf") return encodeFunctionResult({ abi: ABI, functionName, result: 5n * 10n ** 18n });
        if (functionName === "nonces") return encodeFunctionResult({ abi: ABI, functionName, result: 7n });
        if (functionName === "eip712Domain") {
          return encodeFunctionResult({
            abi: ABI,
            functionName,
            result: ["0x0f", "Tesla", "1", BigInt(robinhoodTestnet.id), TSLA, `0x${"0".repeat(64)}`, []],
          });
        }
        throw new Error(`unexpected call ${functionName}`);
      }
      case "eth_getTransactionCount":
        return `0x${sent.length.toString(16)}`;
      case "eth_estimateGas":
        return "0x30000";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_blockNumber":
        return "0x10";
      case "eth_getBlockByNumber":
        return { number: "0x10", baseFeePerGas: "0x1", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1", transactions: [] };
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw as `0x02${string}`);
        const data = tx.data ?? "0x";
        const { functionName, args } = decodeFunctionData({ abi: ABI, data });
        sent.push({ to: tx.to ?? undefined, functionName, args: args ?? [], data });
        return keccak256(raw);
      }
      case "eth_getTransactionReceipt":
        return {
          transactionHash: params[0],
          blockHash: `0x${"ab".repeat(32)}`,
          blockNumber: "0x10",
          transactionIndex: "0x0",
          from: treasury,
          to: TSLA,
          status: "0x1",
          type: "0x2",
          gasUsed: "0x1",
          cumulativeGasUsed: "0x1",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
        };
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params ?? []) }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { sent, calls, fetchMock };
}

function robinhoodAdapter() {
  const entry = REGISTRY.robinhood.testnet;
  if (entry?.kind !== "evm") throw new Error("robinhood testnet is not an EVM entry");
  return guardAdapter(createEvmAdapter({ ...entry, chain: "robinhood", treasuryKey, rpcUrl: "https://rpc.robinhood.test" }));
}

let rpc: ReturnType<typeof fakeRpc>;
beforeEach(() => {
  rpc = fakeRpc();
  vi.stubGlobal("fetch", rpc.fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EIP-2612 permits", () => {
  it("signs a permit the token can recover to the owner", async () => {
    const args = {
      secret: sender,
      token: TSLA,
      chainId: robinhoodTestnet.id,
      domainName: "Tesla",
      domainVersion: "1",
      spender: treasury,
      value: 10n ** 17n,
      nonce: 7n,
      deadline: 2_000_000_000n,
    };
    const { owner, signature } = await signPermit(args);
    expect(owner).toBe(senderAddress);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "Tesla", version: "1", chainId: robinhoodTestnet.id, verifyingContract: TSLA },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: { owner, spender: treasury, value: args.value, nonce: 7n, deadline: args.deadline },
      signature,
    });
    expect(recovered).toBe(senderAddress);
  });
});

describe("Robinhood Chain stock tokens", () => {
  it("adds one asset per stock token and keeps Dial Test USD as the settlement token", () => {
    const adapter = robinhoodAdapter();
    expect(adapter.tokenId).toBe(USD);
    expect(adapter.assets?.list().map((a) => a.symbol)).toEqual(["TSLA", "AMZN", "PLTR", "NFLX", "AMD"]);
    expect(adapter.assets?.list().every((a) => a.decimals === 18)).toBe(true);
    expect(moverFor(adapter, USD)).toBe(adapter);
    expect(() => moverFor(adapter, "0x0000000000000000000000000000000000000001")).toThrow(/cannot move/);
  });

  it("reads balances in millionths of a token", async () => {
    const tsla = moverFor(robinhoodAdapter(), TSLA);
    expect(await tsla.getBalance(senderAddress)).toBe(5_000_000n);
  });

  it("moves shares with a permit to the treasury, then transferFrom carrying the payment id", async () => {
    const tsla = moverFor(robinhoodAdapter(), TSLA);
    const r = await tsla.settle({ fromSecret: sender, to: RECIPIENT, amount: 100_000n, memo: "pi_gift12345678" });

    expect(rpc.sent.map((s) => s.functionName)).toEqual(["permit", "transferFrom"]);
    const [permit, transfer] = rpc.sent;
    expect(permit?.to?.toLowerCase()).toBe(TSLA.toLowerCase());
    const [owner, spender, value, deadline, v, rr, ss] = permit?.args ?? [];
    expect([owner, spender, value]).toEqual([senderAddress, treasury, 10n ** 17n]);
    // The signature is over the token's own EIP-712 domain and the nonce the chain reported.
    const signature = serializeSignature({ r: rr as Hex, s: ss as Hex, v: BigInt(v as number) });
    expect(
      await recoverTypedDataAddress({
        domain: { name: "Tesla", version: "1", chainId: robinhoodTestnet.id, verifyingContract: TSLA },
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: { owner: senderAddress, spender: treasury, value: 10n ** 17n, nonce: 7n, deadline: deadline as bigint },
        signature,
      }),
    ).toBe(senderAddress);

    expect(transfer?.args).toEqual([senderAddress, RECIPIENT, 10n ** 17n]);
    expect(transfer?.data.endsWith(stringToHex("pi_gift12345678").slice(2))).toBe(true);
    expect(r.explorerUrl).toBe(`https://explorer.testnet.chain.robinhood.com/tx/${r.txHash}`);
  });

  it("reads the token's EIP-712 domain once per adapter", async () => {
    const tsla = moverFor(robinhoodAdapter(), TSLA);
    await tsla.settle({ fromSecret: sender, to: RECIPIENT, amount: 1n, memo: "pi_one" });
    await tsla.settle({ fromSecret: sender, to: RECIPIENT, amount: 1n, memo: "pi_two" });
    expect(rpc.calls.filter((c) => c === "eip712Domain")).toHaveLength(1);
    expect(rpc.calls.filter((c) => c === "nonces")).toHaveLength(2);
  });
});

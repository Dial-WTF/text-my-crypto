import {
  type Address,
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  type Hex,
  hashTypedData,
  recoverAddress,
  recoverTypedDataAddress,
} from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTESTOR_MIN_WEI,
  createEvmEscrow,
  ESCROW_ABI,
  EscrowRefusedError,
  type EscrowRpc,
  escrowId,
  fundingNonce,
  type OnChainEscrow,
  refusalOf,
} from "@/lib/settlement/evm-escrow";
import { EscrowClosedError, type EscrowProgram } from "@/lib/settlement/types";

/** Branches of the dial_escrow client the main suite (evm-escrow.test.ts) doesn't reach: races, lost events, failed sends. */

const CONTRACT: Address = "0x00000000000000000000000000000000000e5c00";
const TOKEN: Address = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const CHAIN_ID = 421614;
const DOMAIN = { name: "USD Coin", version: "2" };
const NOW = Date.parse("2026-10-09T12:00:00Z");
const EXPIRES = new Date(NOW + 7 * 86_400_000);

const SENDER_SECRET = new Uint8Array(32).fill(7);
const RECIPIENT: Address = "0x000000000000000000000000000000000000bEEF";

type Sent = { op: string; hash: Hex };

/**
 * dial_escrow as the chain would answer, for the client's point of view: escrows by id, events by
 * transaction, and the contract's refusals. `fail` makes the next write throw; `landed` lets it take
 * effect first (a send whose answer got lost). Signatures are checked like the token and contract would.
 */
function fakeChain() {
  const escrows = new Map<Hex, OnChainEscrow>();
  const events = new Map<string, Hex>();
  const sent: Sent[] = [];
  const state = {
    time: NOW,
    block: 100n,
    attestorWei: ATTESTOR_MIN_WEI,
    fail: null as Error | null,
    landed: false,
    receipt: "success" as "success" | "reverted" | "timeout",
  };
  let n = 0;
  const tx = (op: string): Hex => {
    const hash: Hex = `0x${(++n).toString(16).padStart(64, "0")}`;
    sent.push({ op, hash });
    return hash;
  };
  const refuse = (reason: string) => new EscrowRefusedError(reason, new Error("execution reverted"));
  const write = (op: string, apply: (hash: Hex) => void): Hex => {
    const hash = tx(op);
    if (state.fail) {
      const e = state.fail;
      if (state.landed) apply(hash);
      state.fail = null;
      state.landed = false;
      throw e;
    }
    // A transaction that reverts changes nothing.
    if (state.receipt !== "reverted") apply(hash);
    return hash;
  };
  const get = (id: Hex) => escrows.get(id);

  const rpc: EscrowRpc = {
    async escrow(id) {
      return get(id) ?? { status: "none", sender: "0x0000000000000000000000000000000000000000", token: TOKEN, amount: 0n, expiry: 0n, fundedBlock: 0n, closedBlock: 0n };
    },
    async eventTx(event, id, block) {
      return events.get(`${event}:${id}:${block}`) ?? null;
    },
    async tokenDomain() {
      return DOMAIN;
    },
    async fundWithAuthorization({ id, from, amount, expiry, validBefore, v, r, s }) {
      if (get(id)) throw refuse("AlreadyFunded");
      // The token checks the sender signed exactly this: to the contract, this amount, the contract's nonce.
      const signer = await recoverTypedDataAddress({
        domain: { ...DOMAIN, chainId: CHAIN_ID, verifyingContract: TOKEN },
        types: {
          ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "ReceiveWithAuthorization",
        message: { from, to: CONTRACT, value: amount, validAfter: 0n, validBefore, nonce: fundingNonce(id, expiry) },
        signature: { r, s, v: BigInt(v) },
      });
      if (signer !== from) throw refuse("TokenCallFailed");
      return write("fund", (hash) => {
        const block = ++state.block;
        escrows.set(id, { status: "open", sender: from, token: TOKEN, amount, expiry, fundedBlock: block, closedBlock: 0n });
        events.set(`Funded:${id}:${block}`, hash);
      });
    },
    async claim(id, to) {
      const e = get(id);
      if (e?.status !== "open") throw refuse("NotOpen");
      if (state.time / 1000 >= Number(e.expiry)) throw refuse("Expired");
      return write(`claim:${to}`, (hash) => {
        const block = ++state.block;
        escrows.set(id, { ...e, status: "claimed", closedBlock: block });
        events.set(`Claimed:${id}:${block}`, hash);
      });
    },
    async refundWithSignature(id, { v, r, s }) {
      const e = get(id);
      if (e?.status !== "open") throw refuse("NotOpen");
      const digest = hashTypedData({
        domain: { name: "DialEscrow", version: "1", chainId: CHAIN_ID, verifyingContract: CONTRACT },
        types: { Refund: [{ name: "id", type: "bytes32" }] },
        primaryType: "Refund",
        message: { id },
      });
      if ((await recoverAddress({ hash: digest, signature: { r, s, v: BigInt(v) } })) !== e.sender) throw refuse("NotSender");
      if (state.time / 1000 < Number(e.expiry)) throw refuse("NotExpired");
      return write("refund", (hash) => {
        const block = ++state.block;
        escrows.set(id, { ...e, status: "refunded", closedBlock: block });
        events.set(`Refunded:${id}:${block}`, hash);
      });
    },
    async receipt() {
      if (state.receipt === "timeout") throw new Error("Timed out while waiting for transaction");
      return state.receipt;
    },
    async attestorBalance() {
      return state.attestorWei;
    },
    async topUpAttestor(wei) {
      return write("topup", () => {
        state.attestorWei += wei;
      });
    },
  };
  return { rpc, state, sent, escrows, events, refuse };
}

let chain: ReturnType<typeof fakeChain>;
let escrow: EscrowProgram;

beforeEach(() => {
  chain = fakeChain();
  escrow = createEvmEscrow({
    contract: CONTRACT,
    token: TOKEN,
    chainId: CHAIN_ID,
    explorerTx: (h) => `https://sepolia.arbiscan.io/tx/${h}`,
    rpc: chain.rpc,
    now: () => chain.state.time,
  });
});

const ID = escrowId("pi_one");
const fund = () => escrow.create({ fromSecret: SENDER_SECRET, intentId: "pi_one", amount: 5_000_000n, expiresAt: EXPIRES });
const ops = () => chain.sent.map((s) => s.op);

/** Closes escrow pi_one on the fake chain as if another transaction had, and returns that transaction. */
function closeElsewhere(status: "claimed" | "refunded"): Hex {
  const e = chain.escrows.get(ID);
  if (!e) throw new Error("not funded");
  const block = ++chain.state.block;
  const hash: Hex = `0x${"ee".repeat(32)}`;
  chain.escrows.set(ID, { ...e, status, closedBlock: block });
  chain.events.set(`${status === "claimed" ? "Claimed" : "Refunded"}:${ID}:${block}`, hash);
  return hash;
}

describe("lookup", () => {
  it("a closed escrow whose closing event can't be found is an error, never read as unfunded", async () => {
    await fund();
    const e = chain.escrows.get(ID);
    if (!e) throw new Error("not funded");
    chain.escrows.set(ID, { ...e, status: "claimed", closedBlock: 50n });
    await expect(escrow.lookup("pi_one")).rejects.toThrow("No claimed event for pi_one in block 50");
    // A claim retry doesn't send a second claim on the strength of it.
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toThrow("No claimed event");
    expect(ops()).toEqual(["fund"]);
  });
});

describe("claim", () => {
  it("racing an earlier claim that landed first, returns that claim", async () => {
    await fund();
    const claim = chain.rpc.claim.bind(chain.rpc);
    chain.rpc.claim = async (id, to) => {
      // The earlier send lands between our read and our send; ours is refused.
      await claim(id, to);
      throw chain.refuse("NotOpen");
    };
    const result = await escrow.claim({ intentId: "pi_one", to: RECIPIENT });
    expect(ops()).toEqual(["fund", `claim:${RECIPIENT}`]);
    expect(result.txHash).toBe(chain.sent[1]?.hash);
    expect((await escrow.lookup("pi_one")).state).toBe("claimed");
  });

  it("racing a refund that landed first, is closed: the recipient is not paid", async () => {
    await fund();
    let refundTx: Hex | null = null;
    chain.rpc.claim = async () => {
      refundTx = closeElsewhere("refunded");
      throw chain.refuse("NotOpen");
    };
    const err: unknown = await escrow.claim({ intentId: "pi_one", to: RECIPIENT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EscrowClosedError);
    expect(err).toMatchObject({ outcome: "refunded", result: { txHash: refundTx } });
  });

  it("a claim the node failed to send is not claimed, and nothing moved", async () => {
    await fund();
    chain.state.fail = new Error("fetch failed");
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toThrow("fetch failed");
    expect((await escrow.lookup("pi_one")).state).toBe("open");
  });

  it("passes any other refusal through as it is", async () => {
    await fund();
    chain.state.fail = chain.refuse("NotAttestor");
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toMatchObject({ reason: "NotAttestor" });
    expect((await escrow.lookup("pi_one")).state).toBe("open");
  });

  it("a claim that reverted on-chain is not claimed", async () => {
    await fund();
    chain.state.receipt = "reverted";
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toThrow(/reverted/);
    expect((await escrow.lookup("pi_one")).state).toBe("open");
  });

  it("a gas top-up that reverted stops the claim before it is sent", async () => {
    await fund();
    chain.state.attestorWei = ATTESTOR_MIN_WEI - 1n;
    chain.state.receipt = "reverted";
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toThrow(/reverted/);
    expect(ops()).toEqual(["fund", "topup"]);
    expect(chain.state.attestorWei).toBe(ATTESTOR_MIN_WEI - 1n);
  });
});

describe("refund", () => {
  beforeEach(async () => {
    await fund();
    chain.state.time = EXPIRES.getTime();
  });

  it("racing its own earlier refund that landed first, returns that refund", async () => {
    const refund = chain.rpc.refundWithSignature.bind(chain.rpc);
    chain.rpc.refundWithSignature = async (id, sig) => {
      await refund(id, sig);
      throw chain.refuse("NotOpen");
    };
    const result = await escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET });
    expect(ops()).toEqual(["fund", "refund"]);
    expect(result.txHash).toBe(chain.sent[1]?.hash);
  });

  it("racing a claim that landed first, is closed: the sender gets nothing back", async () => {
    let claimTx: Hex | null = null;
    chain.rpc.refundWithSignature = async () => {
      claimTx = closeElsewhere("claimed");
      throw chain.refuse("NotOpen");
    };
    const err: unknown = await escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EscrowClosedError);
    expect(err).toMatchObject({ outcome: "claimed", result: { txHash: claimTx } });
  });

  it("a refund that reverted on-chain is not refunded", async () => {
    chain.state.receipt = "reverted";
    await expect(escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET })).rejects.toThrow(/reverted/);
    expect((await escrow.lookup("pi_one")).state).toBe("open");
  });
});

describe("refusalOf", () => {
  it("is null when the contract reverted without an error it can name", () => {
    const reverted = new ContractFunctionRevertedError({ abi: ESCROW_ABI, functionName: "claim", message: "execution reverted" });
    const e = new ContractFunctionExecutionError(reverted, { abi: ESCROW_ABI, functionName: "claim", args: [] });
    expect(refusalOf(e)).toBeNull();
  });

  it("is null for a viem error that isn't a revert", () => {
    expect(refusalOf(new BaseError("HTTP request failed."))).toBeNull();
  });
});

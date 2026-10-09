import {
  type Address,
  bytesToHex,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Hex,
  hashTypedData,
  recoverAddress,
  recoverTypedDataAddress,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTESTOR_MIN_WEI,
  ATTESTOR_TOPUP_WEI,
  createEvmEscrow,
  ESCROW_ABI,
  EscrowRefusedError,
  type EscrowRpc,
  escrowId,
  FUNDING_WINDOW_S,
  fundingNonce,
  type OnChainEscrow,
  refusalOf,
  signRefund,
} from "@/lib/settlement/evm-escrow";
import { EscrowClosedError, EscrowExpiredError, type EscrowProgram, EscrowUnconfirmedError } from "@/lib/settlement/types";

const CONTRACT: Address = "0x00000000000000000000000000000000000e5c00";
const TOKEN: Address = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const CHAIN_ID = 421614;
const DOMAIN = { name: "USD Coin", version: "2" };
const NOW = Date.parse("2026-10-09T12:00:00Z");
const EXPIRES = new Date(NOW + 7 * 86_400_000);

const secretOf = (byte: number) => new Uint8Array(32).fill(byte);
const SENDER_SECRET = secretOf(7);
const SENDER = privateKeyToAccount(bytesToHex(SENDER_SECRET)).address;
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
    /** The token the contract was deployed with: it refuses fundings in any other. */
    contractToken: TOKEN,
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
      return get(id) ?? { status: "none", sender: zeroAddress, token: zeroAddress, amount: 0n, expiry: 0n, fundedBlock: 0n, closedBlock: 0n };
    },
    async eventTx(event, id, block) {
      return events.get(`${event}:${id}:${block}`) ?? null;
    },
    async tokenDomain() {
      return DOMAIN;
    },
    async fundWithAuthorization({ id, from, amount, expiry, validBefore, v, r, s }) {
      // The client always sends its configured token (viemEscrowRpc), which here is TOKEN.
      if (state.contractToken !== TOKEN) throw refuse("WrongToken");
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
  return { rpc, state, sent, escrows };
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

const fund = (intentId = "pi_one", amount = 5_000_000n) => escrow.create({ fromSecret: SENDER_SECRET, intentId, amount, expiresAt: EXPIRES });

describe("what the client signs matches the contract", () => {
  // The same vectors as contracts/arbitrum-escrow/src/tests/mod.rs: the contract computes these on-chain.
  it("derives the funding nonce the contract expects", () => {
    expect(escrowId("pi_test")).toBe("0x94f7a868a972292409e93a5940cfab67927a26a03f4336345a35dc65082f59f8");
    expect(fundingNonce(escrowId("pi_test"), 2000n)).toBe("0xe1aef94d42fb31c0479065559722803a9b6f574c72eb9a6e70f7374fc9f97061");
  });

  it("signs the refund digest the contract recovers", async () => {
    const id = escrowId("pi_test");
    const sig = await signRefund({ secret: SENDER_SECRET, chainId: CHAIN_ID, contract: CONTRACT, id });
    const digest = "0x94e4516b05ddbc591e2ce1e855281146a06549244a393674e9effd580523cee9";
    expect(await recoverAddress({ hash: digest, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toBe(SENDER);
    // The contract refuses the high-s twin, so the signature must be low-s.
    expect(BigInt(sig.s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
  });
});

describe("evm escrow", () => {
  it("knows where the money sits before the escrow exists: the contract", async () => {
    expect(await escrow.vaultAddress("pi_one")).toBe(CONTRACT);
    expect(escrow.programId).toBe(CONTRACT);
  });

  it("funds with the sender's authorization in one transaction the treasury sends", async () => {
    const result = await fund();
    expect(chain.sent.map((s) => s.op)).toEqual(["fund"]);
    expect(result.explorerUrl).toBe(`https://sepolia.arbiscan.io/tx/${chain.sent[0]?.hash ?? ""}`);
    expect(await escrow.lookup("pi_one")).toEqual({
      state: "open",
      sender: SENDER,
      amount: 5_000_000n,
      expiresAt: new Date(Math.floor(EXPIRES.getTime() / 1000) * 1000),
      funded: result,
    });
  });

  it("a funding the contract refuses failed: nothing was sent", async () => {
    chain.state.fail = new EscrowRefusedError("TokenCallFailed", new Error("execution reverted"));
    await expect(fund()).rejects.toThrow("dial_escrow refused: TokenCallFailed");
  });

  it("a funding that reverted on-chain failed", async () => {
    chain.state.receipt = "reverted";
    await expect(fund()).rejects.toThrow(/reverted/);
  });

  it("a funding whose answer got lost but landed is funded", async () => {
    chain.state.fail = new Error("fetch failed");
    chain.state.landed = true;
    const result = await fund();
    expect(result.txHash).toBe(chain.sent[0]?.hash);
  });

  it("a funding whose receipt never came, but which landed, is funded", async () => {
    chain.state.receipt = "timeout";
    expect((await fund()).txHash).toBe(chain.sent[0]?.hash);
  });

  it("is never called failed while it could still land", async () => {
    chain.state.fail = new Error("fetch failed");
    await expect(fund()).rejects.toBeInstanceOf(EscrowUnconfirmedError);
  });

  it("is failed once nothing is there and the authorization has run out", async () => {
    chain.state.fail = new Error("fetch failed");
    const pending = fund();
    chain.state.time = NOW + (FUNDING_WINDOW_S + 1) * 1000;
    await expect(pending).rejects.toThrow("fetch failed");
  });

  it("a retry of a funding that already landed returns that funding", async () => {
    const first = await fund();
    expect(await fund()).toEqual(first);
  });

  it("an escrow someone else funded for the same id is not ours", async () => {
    chain.escrows.set(escrowId("pi_one"), {
      status: "open",
      sender: RECIPIENT,
      token: TOKEN,
      amount: 5_000_000n,
      expiry: 1n,
      fundedBlock: 1n,
      closedBlock: 0n,
    });
    await expect(fund()).rejects.toThrow("AlreadyFunded");
  });

  it("a contract deployed with another token refuses our funding: failed, nothing moved", async () => {
    chain.state.contractToken = "0x000000000000000000000000000000000000fa4e";
    await expect(fund()).rejects.toThrow("WrongToken");
    expect(chain.escrows.size).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  it("an escrow opened in our sender's name with another token is not ours: not funded, not claimed, not refunded", async () => {
    // The contract refuses any token but its own, so this is a contract deployed with a token other than
    // ours. A token the attacker wrote could accept a funding without the sender's signature, and
    // everything else about the escrow matches this payment.
    const FAKE: Address = "0x000000000000000000000000000000000000fa4e";
    chain.escrows.set(escrowId("pi_one"), {
      status: "open",
      sender: SENDER,
      token: FAKE,
      amount: 5_000_000n,
      expiry: BigInt(EXPIRES.getTime() / 1000),
      fundedBlock: 1n,
      closedBlock: 0n,
    });
    await expect(fund()).rejects.toThrow("AlreadyFunded");
    await expect(escrow.lookup("pi_one")).rejects.toThrow("holds another token");
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toThrow("holds another token");
    chain.state.time = EXPIRES.getTime();
    await expect(escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET })).rejects.toThrow("holds another token");
    // Nothing was sent: no claim of the fake token, and no refund recorded as if it were ours.
    expect(chain.sent).toEqual([]);
  });

  it("claims from the attestor to the recipient", async () => {
    await fund();
    const result = await escrow.claim({ intentId: "pi_one", to: RECIPIENT });
    expect(chain.sent.map((s) => s.op)).toEqual(["fund", `claim:${RECIPIENT}`]);
    expect(await escrow.lookup("pi_one")).toEqual({ state: "claimed", result });
  });

  it("tops the attestor up from the treasury when it runs low on gas", async () => {
    await fund();
    chain.state.attestorWei = ATTESTOR_MIN_WEI - 1n;
    await escrow.claim({ intentId: "pi_one", to: RECIPIENT });
    expect(chain.sent.map((s) => s.op)).toEqual(["fund", "topup", `claim:${RECIPIENT}`]);
    expect(chain.state.attestorWei).toBe(ATTESTOR_MIN_WEI - 1n + ATTESTOR_TOPUP_WEI);
  });

  it("a claim that already landed returns its transaction; a refunded escrow can't be claimed", async () => {
    await fund();
    const claimed = await escrow.claim({ intentId: "pi_one", to: RECIPIENT });
    expect(await escrow.claim({ intentId: "pi_one", to: RECIPIENT })).toEqual(claimed);

    await fund("pi_two");
    chain.state.time = EXPIRES.getTime();
    const refunded = await escrow.refund({ intentId: "pi_two", senderSecret: SENDER_SECRET });
    await expect(escrow.claim({ intentId: "pi_two", to: RECIPIENT })).rejects.toEqual(new EscrowClosedError("refunded", refunded));
  });

  it("names a claim the contract refuses for expiry", async () => {
    await fund();
    chain.state.time = EXPIRES.getTime();
    await expect(escrow.claim({ intentId: "pi_one", to: RECIPIENT })).rejects.toBeInstanceOf(EscrowExpiredError);
  });

  it("refunds after expiry with the sender's signature, sent by the treasury", async () => {
    await fund();
    chain.state.time = EXPIRES.getTime();
    const result = await escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET });
    expect(chain.sent.map((s) => s.op)).toEqual(["fund", "refund"]);
    expect(await escrow.lookup("pi_one")).toEqual({ state: "refunded", result });
    expect(await escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET })).toEqual(result);
  });

  it("can't refund without the sender's key, with someone else's, or before expiry", async () => {
    await fund();
    chain.state.time = EXPIRES.getTime();
    await expect(escrow.refund({ intentId: "pi_one" })).rejects.toThrow("refunds only on its sender's signature");
    await expect(escrow.refund({ intentId: "pi_one", senderSecret: secretOf(9) })).rejects.toThrow("funded by another wallet");
    chain.state.time = EXPIRES.getTime() - 1000;
    await expect(escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET })).rejects.toThrow("NotExpired");
  });

  it("a claimed escrow can't be refunded", async () => {
    await fund();
    const claimed = await escrow.claim({ intentId: "pi_one", to: RECIPIENT });
    chain.state.time = EXPIRES.getTime();
    await expect(escrow.refund({ intentId: "pi_one", senderSecret: SENDER_SECRET })).rejects.toEqual(new EscrowClosedError("claimed", claimed));
  });

  it("finds nothing for an id that was never funded", async () => {
    expect(await escrow.lookup("pi_nobody")).toEqual({ state: "none" });
    await expect(escrow.claim({ intentId: "pi_nobody", to: RECIPIENT })).rejects.toThrow("No escrow for pi_nobody");
  });
});

describe("refusalOf", () => {
  it("names the contract's custom error inside viem's error", () => {
    const data = encodeErrorResult({ abi: ESCROW_ABI, errorName: "Expired" });
    const reverted = new ContractFunctionRevertedError({ abi: ESCROW_ABI, data, functionName: "claim" });
    const e = new ContractFunctionExecutionError(reverted, { abi: ESCROW_ABI, functionName: "claim", args: [] });
    expect(refusalOf(e)).toBe("Expired");
  });

  it("is null for anything that isn't the contract refusing", () => {
    expect(refusalOf(new Error("fetch failed"))).toBeNull();
  });
});

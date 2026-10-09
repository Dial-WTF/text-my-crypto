import { describe, expect, it } from "vitest";
import { usdToBaseUnits } from "@/lib/money";
import { assetOf, money } from "@/lib/settlement/amounts";
import { errorText, redactUrls } from "@/lib/settlement/redact";
import {
  decodeEscrowAccount,
  ESCROW_DISCRIMINATORS,
  escrowErrorCode,
  escrowErrorName,
  escrowEventsFromLogs,
} from "@/lib/settlement/solana-escrow";
import { ChainDownError, guardAdapter, type SettlementAdapter } from "@/lib/settlement/types";
import { SettlementUnknownError } from "@/lib/settlement/unconfirmed";

describe("assetOf", () => {
  it("names Zcash's own coin where it settles, and USDC everywhere else", () => {
    expect(assetOf("zcash", "testnet")).toBe("TAZ");
    expect(assetOf("solana", "testnet")).toBe("USDC");
    expect(assetOf("base", "mainnet")).toBe("USDC");
  });

  it("says USDC for a chain with no entry on the network, and money() shows plain dollars there", () => {
    expect(assetOf("zcash", "mainnet")).toBe("USDC");
    expect(money(usdToBaseUnits("5"), "zcash", "mainnet")).toBe("$5");
  });
});

describe("errorText", () => {
  it("redacts keys from a thrown string, not only from Error messages", () => {
    const text = errorText("fetch failed: https://user:k3y@solana-devnet.example/v2/k3y?api-key=k3y");
    expect(text).toBe("fetch failed: solana-devnet.example/…");
    expect(text).not.toContain("k3y");
  });

  it("redacts keys from an Error's message", () => {
    expect(errorText(new Error("429 from wss://rpc.example/ws/SECRET"))).toBe("429 from rpc.example/…");
  });

  it("stringifies values that aren't errors or strings", () => {
    expect(errorText(42)).toBe("42");
    expect(errorText(undefined)).toBe("undefined");
  });

  it("leaves text without URLs alone", () => {
    expect(redactUrls("insufficient funds")).toBe("insufficient funds");
  });
});

describe("guardAdapter", () => {
  const failing = (err: Error): SettlementAdapter =>
    ({
      chain: "zcash",
      tokenId: "TAZ",
      isValidAddress: () => true,
      createWallet: () => Promise.reject(err),
      getBalance: () => Promise.reject(err),
      settle: () => Promise.reject(err),
      fund: () => Promise.reject(err),
      treasuryAddress: () => Promise.resolve("utest1treasury"),
    }) satisfies SettlementAdapter;

  it("passes a ChainDownError (or a subclass) through as-is, so a maybe-sent drip stays distinguishable", async () => {
    const unknown = new SettlementUnknownError("zcash", new Error("timeout"));
    const guarded = guardAdapter(failing(unknown));
    await expect(guarded.fund("utest1x", 1n)).rejects.toBe(unknown);
    await expect(guarded.createWallet()).rejects.toBeInstanceOf(SettlementUnknownError);
  });

  it("wraps anything else as the chain being down, naming the chain", async () => {
    const guarded = guardAdapter(failing(new Error("503 from https://wallet.example/v1/balance?token=s3cret")));
    const err: unknown = await guarded.getBalance("utest1x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainDownError);
    expect(err).toMatchObject({ chain: "zcash", message: "zcash RPC unavailable: 503 from wallet.example/…" });
  });

  it("leaves settle unwrapped: its failures are recorded on the payment as they are", async () => {
    const boom = new Error("rejected");
    await expect(guardAdapter(failing(boom)).settle({ fromSecret: new Uint8Array(0), to: "x", amount: 1n, memo: "m" })).rejects.toBe(boom);
  });
});

describe("dial_escrow client", () => {
  it("names no error for a code the program doesn't have", () => {
    expect(escrowErrorName(6999)).toBeNull();
    expect(escrowErrorName(0)).toBeNull();
  });

  it("ignores a context code that isn't one of the program's", () => {
    expect(escrowErrorCode({ context: { code: 1 } })).toBeNull();
    expect(escrowErrorCode({ cause: { context: { code: 6002 } } })).toBe(6002);
  });

  it("refuses to decode an account that isn't a dial_escrow Escrow", () => {
    const data = new Uint8Array(8 + 32 * 5 + 8 * 3 + 2);
    expect(() => decodeEscrowAccount(data)).toThrow("Not a dial_escrow Escrow account");
    data.set(ESCROW_DISCRIMINATORS.escrowCreated);
    expect(() => decodeEscrowAccount(data)).toThrow("Not a dial_escrow Escrow account");
  });

  it("skips program data from other programs (or other events) in the logs", () => {
    const other = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).toString("base64");
    const account = Buffer.from([...ESCROW_DISCRIMINATORS.escrow, 0, 0]).toString("base64");
    const pid = "Escrow1111111111111111111111111111111111111";
    const logs = [`Program ${pid} invoke [1]`, `Program data: ${other}`, `Program data: ${account}`, "Program log: hello", `Program ${pid} success`];
    expect(escrowEventsFromLogs(logs, pid)).toEqual([]);
  });
});

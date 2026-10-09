import { describe, expect, it } from "vitest";
import { fundingVerdict } from "@/lib/settlement/unconfirmed";
import type { EscrowLookup } from "@/lib/settlement/types";

const funded = { txHash: "sig_create", explorerUrl: "https://explorer.test/sig_create" };
const open = (over: Partial<Extract<EscrowLookup, { state: "open" }>> = {}): EscrowLookup => ({
  state: "open",
  sender: "Sender111",
  amount: 5_000_000n,
  expiresAt: new Date("2026-10-16T12:00:00Z"),
  funded,
  ...over,
});
const verdict = (found: EscrowLookup | null, { definite = false, expired = false } = {}) =>
  fundingVerdict({ definite, found, sender: "Sender111", amount: 5_000_000n, expired }).kind;

describe("after a failed escrow funding", () => {
  it("counts it funded when the chain holds this sender's escrow for this amount, whatever the error said", () => {
    expect(fundingVerdict({ definite: false, found: open(), sender: "Sender111", amount: 5_000_000n, expired: false })).toEqual({
      kind: "funded",
      result: funded,
    });
    expect(verdict(open(), { definite: true })).toBe("funded");
  });

  it("calls it failed only when the send certainly didn't land", () => {
    expect(verdict({ state: "none" }, { definite: true })).toBe("failed");
    // Nothing there and the blockhash has expired: it can't land any more.
    expect(verdict({ state: "none" }, { expired: true })).toBe("failed");
  });

  it("is unconfirmed when the RPC broke while the transaction could still land", () => {
    // A 503 mid-confirm: nothing there yet, but the blockhash is still valid.
    expect(verdict({ state: "none" })).toBe("unconfirmed");
    // The lookup itself failed.
    expect(verdict(null)).toBe("unconfirmed");
    expect(verdict(null, { expired: true })).toBe("unconfirmed");
  });

  it("never takes someone else's escrow as this payment's", () => {
    expect(verdict(open({ amount: 4_000_000n }), { expired: true })).toBe("unconfirmed");
    expect(verdict(open({ sender: "Other111" }), { definite: true })).toBe("failed");
    expect(verdict(open({ funded: null }))).toBe("unconfirmed");
  });
});

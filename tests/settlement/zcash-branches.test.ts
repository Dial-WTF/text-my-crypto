import { afterEach, describe, expect, it, vi } from "vitest";
import { SettlementUnknownError } from "@/lib/settlement/unconfirmed";
import {
  createZcashAdapter,
  decodeAccount,
  encodeAccount,
  isZcashShieldedAddress,
  usdToZats,
  ZcashServiceError,
  zatsToUsd,
  type ZcashConfig,
} from "@/lib/settlement/zcash";

const TOKEN = "t".repeat(40);

type Answer = { status: number; body: string };

/** A wallet service that gives the same answer to everything, and records what it was sent. */
function fakeService(answer: Answer) {
  const sent: { url: string; body: unknown }[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
    return Promise.resolve(new Response(answer.body, { status: answer.status }));
  });
  return { sent, fetch };
}

function adapter(fetch: typeof globalThis.fetch, over: Partial<ZcashConfig> = {}) {
  return createZcashAdapter({
    sleep: () => Promise.resolve(),
    serviceUrl: "https://wallet.example",
    token: TOKEN,
    usdPerZec: 50,
    asset: "TAZ",
    addressPrefix: "utest1",
    explorerTx: (h) => `https://explorer.example/tx/${h}`,
    fetch,
    ...over,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("zcash demo rate", () => {
  it("refuses a rate that would divide by zero or flip the sign, rather than convert at it", () => {
    for (const rate of [0, -50, Number.NaN, Number.POSITIVE_INFINITY, 0.004]) {
      expect(() => usdToZats(1_000_000n, rate), String(rate)).toThrow(RangeError);
      expect(() => zatsToUsd(100_000_000n, rate), String(rate)).toThrow(RangeError);
    }
  });

  it("accepts a rate of a cent, the smallest it can represent", () => {
    expect(usdToZats(10_000n, 0.01)).toBe(100_000_000n);
  });
});

describe("zcash addresses", () => {
  it("rejects characters outside the bech32 alphabet", () => {
    // "b", "i", "o" and "1" (after the separator) are not in bech32's alphabet.
    expect(isZcashShieldedAddress("utest1qqqqqqqqb", "utest1")).toBe(false);
    expect(isZcashShieldedAddress("utest1qqqqqqqqi", "utest1")).toBe(false);
  });

  it("rejects an address too short to hold a checksum", () => {
    expect(isZcashShieldedAddress("utest1qqqqq", "utest1")).toBe(false);
    expect(isZcashShieldedAddress("ztestsapling1qq", "utest1")).toBe(false);
  });
});

describe("zcash wallet secrets", () => {
  it("refuses JSON that isn't an object, so a stray secret from another chain can't send from account 0", () => {
    for (const json of ["5", "null", '"zcashAccount"', "[3]"]) {
      expect(() => decodeAccount(new TextEncoder().encode(json)), json).toThrow("Not a Zcash wallet secret");
    }
    expect(decodeAccount(encodeAccount(3))).toBe(3);
  });
});

describe("zcash service errors", () => {
  it("still reports a refusal whose body names no code or message", async () => {
    const { fetch } = fakeService({ status: 400, body: "{}" });
    const err: unknown = await adapter(fetch).treasuryAddress().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZcashServiceError);
    expect(err).toMatchObject({ status: 400, code: "error", maybeSent: false });
    expect(String(err)).not.toContain(TOKEN);
  });

  it("keeps the service's code when it gives one without a message", async () => {
    const { fetch } = fakeService({ status: 402, body: JSON.stringify({ error: "insufficient_funds" }) });
    await expect(adapter(fetch).treasuryAddress()).rejects.toMatchObject({ status: 402, code: "insufficient_funds" });
  });
});

describe("zcash sends", () => {
  it("refuses an amount below one zatoshi instead of sending nothing", async () => {
    const { fetch, sent } = fakeService({ status: 200, body: JSON.stringify({ txid: "abc" }) });
    await expect(
      adapter(fetch).settle({ fromSecret: encodeAccount(2), to: "utest1x", amount: 0n, memo: "intent-1" }),
    ).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });

  it("still sweeps an escrow whose recorded amount rounds to nothing, so its dust goes somewhere", async () => {
    const { fetch, sent } = fakeService({ status: 200, body: JSON.stringify({ txid: "sweep-tx" }) });
    const result = await adapter(fetch).settle({
      fromSecret: encodeAccount(4),
      to: "utest1x",
      amount: 0n,
      memo: "intent-2",
      closeSource: true,
    });
    expect(result).toEqual({ txHash: "sweep-tx", explorerUrl: "https://explorer.example/tx/sweep-tx" });
    expect(sent[0]?.body).toMatchObject({ account: 4, zats: 0, sweep: true, carry: 1 });
  });

  it("waits between retries on real timers when no sleep is given, then reports the send as unknown", async () => {
    vi.useFakeTimers();
    const { fetch } = fakeService({ status: 503, body: JSON.stringify({ error: "busy", message: "proving" }) });
    const zcash = adapter(fetch, { sleep: undefined });

    const outcome = zcash.fund("utest1x", 1_000_000n).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);

    const err = await outcome;
    expect(err).toBeInstanceOf(SettlementUnknownError);
    expect(err).toMatchObject({ chain: "zcash" });
  });
});

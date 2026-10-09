import { describe, expect, it, vi } from "vitest";
import {
  coreUsdToBaseUnits,
  formatPrice,
  hyperCoreFor,
  midPrice,
  PRICE_INFO_URL,
  spotUsdc,
} from "@/lib/settlement/hypercore";
import { ChainDownError } from "@/lib/settlement/types";

const USER = "0x00000000000000000000000000000000000a11ce";

/** A fetch that answers Hyperliquid's info API from `answers`, keyed by request type, and records the calls. */
function infoApi(answers: Record<string, unknown>, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(answers[String(body.type)] ?? null), { status });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe("hyperCoreFor", () => {
  it("knows HyperCore on both networks, with Circle's CoreDepositWallet", () => {
    expect(hyperCoreFor("testnet")).toMatchObject({
      network: "HyperCore testnet",
      infoUrl: "https://api.hyperliquid-testnet.xyz/info",
      coreDepositWallet: "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206",
    });
    expect(hyperCoreFor("mainnet")).toMatchObject({ network: "HyperCore", infoUrl: "https://api.hyperliquid.xyz/info" });
  });
});

describe("coreUsdToBaseUnits", () => {
  it.each([
    ["0.0", 0n],
    ["5", 5_000_000n],
    ["12.5", 12_500_000n],
    ["1.23456789", 1_234_567n],
  ])("%s", (total, base) => {
    expect(coreUsdToBaseUnits(total)).toBe(base);
  });

  it("rejects anything that isn't a decimal", () => {
    expect(() => coreUsdToBaseUnits("-1")).toThrow();
  });
});

describe("spotUsdc", () => {
  it("reads USDC (token 0) from the account's spot balances", async () => {
    const api = infoApi({
      spotClearinghouseState: {
        balances: [
          { coin: "PURR", token: 1, total: "40.0", hold: "0.0", entryNtl: "0.0" },
          { coin: "USDC", token: 0, total: "5.25000000", hold: "0.0", entryNtl: "0.0" },
        ],
      },
    });
    expect(await spotUsdc("https://info.test", USER, api.fetchFn)).toBe(5_250_000n);
    expect(api.calls).toEqual([{ url: "https://info.test", body: { type: "spotClearinghouseState", user: USER } }]);
  });

  it("is zero for an account HyperCore hasn't seen", async () => {
    expect(await spotUsdc("https://info.test", USER, infoApi({ spotClearinghouseState: { balances: [] } }).fetchFn)).toBe(0n);
  });

  it("says Hyperliquid isn't answering when the API fails", async () => {
    await expect(spotUsdc("https://info.test", USER, infoApi({}, 502).fetchFn)).rejects.toBeInstanceOf(ChainDownError);
  });
});

describe("midPrice", () => {
  it("reads the mainnet mid for a coin, whatever its case", async () => {
    const api = infoApi({ allMids: { BTC: "82355.5", HYPE: "85.2835", "@107": "1.0" } });
    expect(await midPrice("btc", api.fetchFn)).toBe("82355.5");
    expect(await midPrice("$HYPE", api.fetchFn)).toBe("85.2835");
    expect(api.calls.every((c) => c.url === PRICE_INFO_URL && c.body.type === "allMids")).toBe(true);
  });

  it("is null for a coin Hyperliquid doesn't list", async () => {
    expect(await midPrice("NOPE", infoApi({ allMids: { BTC: "1" } }).fetchFn)).toBeNull();
  });
});

describe("formatPrice", () => {
  it.each([
    ["82355.5", "$82,355.50"],
    ["85.2835", "$85.28"],
    ["0.000123", "$0.000123"],
  ])("%s", (mid, out) => {
    expect(formatPrice(mid)).toBe(out);
  });
});

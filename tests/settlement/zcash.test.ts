import { describe, expect, it } from "vitest";
import { usdToBaseUnits } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import { money, namesItsCoin } from "@/lib/settlement/amounts";
import { REGISTRY } from "@/lib/settlement/registry";
import {
  createZcashAdapter,
  decodeAccount,
  encodeAccount,
  formatZec,
  isZcashShieldedAddress,
  usdToZats,
  ZcashServiceError,
  zatsToUsd,
} from "@/lib/settlement/zcash";

// A unified address (Orchard + Sapling) from a throwaway seed, and a syntactically valid Sapling address.
const UA =
  "utest1gfr502jf9wj30hsch78navn5ne8gcyenuyylumm4nt5zlngsvfpp76clwwt7acc0sqefqqznmr32yuqhxuql295u9tnrt98uprscgau2pkzluhknfdqvl6shknrklqwj9vhse8ef3pj9ha49vy7g0yuvhkt5rtnf3nqty5ndsyndxcl2";
const SAPLING = "ztestsapling1m45tl79nmeuf9xax4zxvkqj8gcfptqgsq07prd0a0zuyvxgnk6y6ukkxm0uz8lh73h93v7pya8v";
const TOKEN = "t".repeat(40);

type Call = { method: string; path: string; auth: string | null; body: unknown };

/** A stand-in for services/zcash-wallet: records calls and answers from a route table. */
function fakeService(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization"), body });
    const route = routes[`${method} ${url.pathname}`] ?? routes[`${method} ${url.pathname.replace(/[^/]+$/, ":address")}`];
    if (!route) return new Response(JSON.stringify({ error: "not_found", message: "no route" }), { status: 404 });
    const { status = 200, json } = route(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const entry = REGISTRY.zcash.testnet;
if (entry?.kind !== "zcash" || entry.usdPerZec === null) throw new Error("zcash testnet entry missing");
const RATE = entry.usdPerZec;

function adapter(fetch: typeof globalThis.fetch) {
  return createZcashAdapter({
    serviceUrl: "https://wallet.example/",
    token: TOKEN,
    usdPerZec: RATE,
    asset: "TAZ",
    addressPrefix: "utest1",
    explorerTx: entry!.explorerTx,
    fetch,
  });
}

describe("zcash amounts", () => {
  it("converts dollars at the demo rate: $5 is 0.1 TAZ at $50", () => {
    expect(RATE).toBe(50);
    expect(usdToZats(usdToBaseUnits("5"), RATE)).toBe(10_000_000n);
    expect(zatsToUsd(10_000_000n, RATE)).toBe(usdToBaseUnits("5"));
    expect(usdToZats(usdToBaseUnits("0.01"), RATE)).toBe(20_000n);
  });

  it("rounds down both ways, so nobody is shown more than they have", () => {
    expect(zatsToUsd(19_999n, RATE)).toBe(9_999n);
    expect(usdToZats(1n, 3)).toBe(33n);
  });

  it("formats coins without trailing zeros", () => {
    expect(formatZec(10_000_000n)).toBe("0.1");
    expect(formatZec(100_000_000n)).toBe("1");
    expect(formatZec(12_345n)).toBe("0.00012345");
  });

  it("says the coin next to the dollars on Zcash, and only dollars elsewhere", () => {
    expect(money(usdToBaseUnits("5"), "zcash", "testnet")).toBe("$5 (0.1 TAZ)");
    expect(money(usdToBaseUnits("5"), "solana", "testnet")).toBe("$5");
    expect(namesItsCoin("$5 (0.1 TAZ)")).toBe(true);
    expect(namesItsCoin("$5")).toBe(false);
  });

  it("never calls testnet ZEC USDC in replies", () => {
    const zec = money(usdToBaseUnits("5"), "zcash", "testnet");
    const confirm = replies.confirmSend(zec, "alex", "Zcash", null, "123456", "https://x/a/pi_1");
    expect(confirm).toBe("Send $5 (0.1 TAZ) to alex on Zcash? Reply 123456 to confirm, or tap: https://x/a/pi_1");
    expect(replies.insufficient(zec, "https://x/@alex", true, null)).toContain("$5 (0.1 TAZ) in testnet ZEC");
    expect(replies.dripped(zec)).toContain("$5 (0.1 TAZ) of testnet ZEC");
    expect(replies.claimOffer(zec, "sam", "123456")).not.toContain("USDC");
    // Stablecoin chains read exactly as before.
    expect(replies.confirmSend("$5", "alex", "Solana", null, "123456", "https://x/a/pi_1")).toContain("Send $5 USDC to alex");
  });
});

describe("zcash addresses", () => {
  it("accepts testnet unified and Sapling addresses", () => {
    expect(isZcashShieldedAddress(UA, "utest1")).toBe(true);
    expect(isZcashShieldedAddress(SAPLING, "utest1")).toBe(true);
  });

  it("rejects typos, other networks, transparent addresses and other chains", () => {
    expect(isZcashShieldedAddress(`${UA.slice(0, -1)}q`, "utest1")).toBe(false);
    expect(isZcashShieldedAddress(UA.toUpperCase(), "utest1")).toBe(false);
    expect(isZcashShieldedAddress(UA, "u1")).toBe(false);
    expect(isZcashShieldedAddress("tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd", "utest1")).toBe(false);
    expect(isZcashShieldedAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "utest1")).toBe(false);
  });
});

describe("zcash wallet secrets", () => {
  it("stores only the service account number, never keys", () => {
    const secret = encodeAccount(7);
    expect(new TextDecoder().decode(secret)).toBe('{"zcashAccount":7}');
    expect(decodeAccount(secret)).toBe(7);
  });

  it("refuses the treasury account and anything that isn't a Zcash secret", () => {
    expect(() => decodeAccount(encodeAccount(0))).toThrow();
    expect(() => decodeAccount(new TextEncoder().encode("x".repeat(64)))).toThrow();
    expect(() => decodeAccount(new Uint8Array(64))).toThrow();
  });
});

describe("zcash adapter", () => {
  it("creates wallets as service accounts and authenticates every call", async () => {
    const svc = fakeService({ "POST /v1/accounts": () => ({ json: { account: 3, address: UA } }) });
    const w = await adapter(svc.fetch).createWallet();
    expect(w.address).toBe(UA);
    expect(decodeAccount(w.secret)).toBe(3);
    expect(svc.calls[0]).toMatchObject({ method: "POST", path: "/v1/accounts", auth: `Bearer ${TOKEN}` });
  });

  it("reports the balance in dollars, holding one network fee back", async () => {
    const svc = fakeService({ "GET /v1/balance/:address": () => ({ json: { account: 3, total: 10_010_000, spendable: 0 } }) });
    expect(await adapter(svc.fetch).getBalance(UA)).toBe(usdToBaseUnits("5"));
    expect(svc.calls[0]?.path).toBe(`/v1/balance/${UA}`);
  });

  it("never reports a negative balance", async () => {
    const svc = fakeService({ "GET /v1/balance/:address": () => ({ json: { total: 5_000 } }) });
    expect(await adapter(svc.fetch).getBalance(UA)).toBe(0n);
  });

  it("sends zatoshis from the sender's account with the payment id as the memo", async () => {
    const svc = fakeService({ "POST /v1/send": () => ({ json: { txid: "ab".repeat(32) } }) });
    const res = await adapter(svc.fetch).settle({ fromSecret: encodeAccount(3), to: UA, amount: usdToBaseUnits("5"), memo: "pi_abc" });
    expect(res).toEqual({ txHash: "ab".repeat(32), explorerUrl: `https://testnet.zcashexplorer.app/transactions/${"ab".repeat(32)}` });
    expect(svc.calls[0]?.body).toMatchObject({ account: 3, to: UA, zats: 10_000_000, memo: "pi_abc", sweep: false });
    expect((svc.calls[0]?.body as { wait: number }).wait).toBeGreaterThan(75);
  });

  it("sweeps an escrow when closing it", async () => {
    const svc = fakeService({ "POST /v1/send": () => ({ json: { txid: "cd".repeat(32) } }) });
    await adapter(svc.fetch).settle({ fromSecret: encodeAccount(9), to: UA, amount: usdToBaseUnits("5"), memo: "pi_esc", closeSource: true });
    expect(svc.calls[0]?.body).toMatchObject({ account: 9, sweep: true, memo: "pi_esc" });
  });

  it("drips from the treasury with one fee on top, so the full amount can be sent on", async () => {
    const svc = fakeService({ "POST /v1/fund": () => ({ json: { txid: "ef".repeat(32) } }) });
    await adapter(svc.fetch).fund(UA, usdToBaseUnits("1"));
    expect(svc.calls[0]?.body).toMatchObject({ to: UA, zats: 2_000_000 + 10_000 });
  });

  it("returns the treasury address", async () => {
    const svc = fakeService({ "GET /v1/treasury": () => ({ json: { account: 0, address: UA } }) });
    expect(await adapter(svc.fetch).treasuryAddress()).toBe(UA);
  });

  it("surfaces service errors with their code, never the token", async () => {
    const svc = fakeService({
      "POST /v1/send": () => ({ status: 409, json: { error: "insufficient_funds", message: "have 0, need 11000" } }),
    });
    const err = await adapter(svc.fetch)
      .settle({ fromSecret: encodeAccount(3), to: UA, amount: usdToBaseUnits("5"), memo: "pi_x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZcashServiceError);
    expect((err as ZcashServiceError).code).toBe("insufficient_funds");
    expect(String(err)).not.toContain(TOKEN);
  });

  it("treats a non-JSON answer (say, a proxy error page) as an error", async () => {
    const fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof globalThis.fetch;
    await expect(adapter(fetch).treasuryAddress()).rejects.toThrow(/502 bad_response/);
  });
});

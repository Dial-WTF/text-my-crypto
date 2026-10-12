import { beforeEach, describe, expect, it } from "vitest";
import { handleMcpRequest } from "@/lib/agents/mcp";
import { redeemAgentLink } from "@/lib/agents/keys";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { findUserByPhone } from "@/lib/identity";
import { getIntent, sentSince } from "@/lib/intents";
import { publicStats, recentPayments } from "@/lib/stats";
import type { AssetTransfers } from "@/lib/settlement/capabilities";
import { buildPaymentView } from "@/lib/views/payment";
import { cardAmount } from "@/lib/web/receipt-card";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, type SettleCall, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";
const NEWBIE = "+15550000099";
const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const AMZN = "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02";
const STOCKS = [
  ["TSLA", TSLA],
  ["AMZN", AMZN],
  ["PLTR", "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0"],
  ["NFLX", "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93"],
  ["AMD", "0x71178BAc73cBeb415514eB542a8995b82669778d"],
] as const;

type FakeAsset = { settled: SettleCall[]; balances: Map<string, bigint> };

/** The `assets` module on a fake Robinhood Chain: balances in millionths of a token, and every move recorded per stock. */
function fakeStocks(): { transfers: AssetTransfers; bySymbol: Map<string, FakeAsset> } {
  const bySymbol = new Map<string, FakeAsset>(STOCKS.map(([s]) => [s, { settled: [], balances: new Map() }]));
  const of = (symbol: string): FakeAsset => bySymbol.get(symbol) ?? { settled: [], balances: new Map() };
  const transfers: AssetTransfers = {
    list: () => STOCKS.map(([symbol, address]) => ({ symbol, name: symbol === "TSLA" ? "Tesla" : symbol, address, decimals: 18 })),
    balanceOf: async (address, asset) => of(asset.symbol).balances.get(address) ?? 0n,
    transfer: async ({ to, asset, amount, memo }) => {
      of(asset.symbol).settled.push({ to, amount, memo, closeSource: false });
      const hash = `0x${asset.symbol}_${memo}`;
      return { txHash: hash, explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${hash}` };
    },
  };
  return { transfers, bySymbol };
}

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let rh: FakeAdapter;
let tsla: FakeAsset;
let amzn: FakeAsset;
let k = 0;

const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `k${++k}` });
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";

async function signUp(phone: string, name: string) {
  await say(phone, "hi");
  await say(phone, `call me ${name}`);
}

async function walletOf(phone: string): Promise<string> {
  const u = await findUserByPhone(db, phone);
  const w = u ? await getWallet(db, u.id, "robinhood") : null;
  if (!w) throw new Error(`no robinhood wallet for ${phone}`);
  return w.address;
}

/** Opens Jeremy's Robinhood Chain wallet ("stocks") and puts `units` of TSLA in it. */
async function giveJeremyTsla(units: bigint) {
  await say(JEREMY, "stocks");
  tsla.balances.set(await walletOf(JEREMY), units);
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  const stocks = fakeStocks();
  const assets = stocks.transfers;
  tsla = stocks.bySymbol.get("TSLA") as FakeAsset;
  amzn = stocks.bySymbol.get("AMZN") as FakeAsset;
  rh = { ...fakeAdapter({ chain: "robinhood", defaultBalance: 100_000_000n }), tokenId: "0x2195e3E09eab088c90B4461B92D06A74d30c1e2e", assets };
  deps = testDeps(db, {
    sendSms: sms.sendSms,
    adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }), robinhood: rh },
  });
  await signUp(ALEX, "Alex");
  await signUp(JEREMY, "Jeremy");
});

describe("stocks by text", () => {
  it("with none yet, points at Robinhood's faucet with their Robinhood Chain address", async () => {
    const reply = await say(JEREMY, "stocks");
    const address = await walletOf(JEREMY);
    expect(reply).toBe(
      `No stock tokens yet on Robinhood Chain testnet. Get TSLA, AMZN, PLTR, NFLX, AMD free at faucet.testnet.chain.robinhood.com for your address ${address}`,
    );
  });

  it("lists what they hold, in shares, with no prices", async () => {
    await giveJeremyTsla(5_000_000n);
    amzn.balances.set(await walletOf(JEREMY), 500_000n);
    expect(await say(JEREMY, "portfolio")).toBe(
      'Your stock tokens on Robinhood Chain testnet: 5 TSLA, 0.5 AMZN. Send some: "send @name 0.1 TSLA". Testnet has no prices.',
    );
  });

  it("gifts 0.1 TSLA: approve by code, settle the stock token, receipts both ways", async () => {
    await giveJeremyTsla(5_000_000n);
    const ask = await say(JEREMY, "send @alex 0.1 TSLA for your birthday");
    expect(ask).toMatch(/^Send 0\.1 TSLA to @alex \(your birthday\) on Robinhood Chain\? Reply \d{6} to confirm\. Details: https:\/\/tmc\.test\/a\/pi_/);
    expect(ask.length).toBeLessThanOrEqual(160);

    const id = intentIdIn(ask);
    expect(await getIntent(db, id)).toMatchObject({ chain: "robinhood", token: TSLA, amount: 100_000n, status: "pending" });

    await say(JEREMY, codeIn(ask));
    expect(tsla.settled).toEqual([{ to: await walletOf(ALEX), amount: 100_000n, memo: id, closeSource: false }]);
    expect(rh.settled).toEqual([]);
    expect(sms.to(JEREMY)).toContain(`Sent 0.1 TSLA to Alex on Robinhood Chain. Receipt: https://explorer.testnet.chain.robinhood.com/tx/0xTSLA_${id}`);
    expect(sms.last(ALEX)).toBe(
      `Alex, you got 0.1 TSLA from Jeremy (your birthday) on Robinhood Chain. Receipt: https://explorer.testnet.chain.robinhood.com/tx/0xTSLA_${id}`,
    );
    expect((await getIntent(db, id))?.status).toBe("settled");
    expect(await say(JEREMY, "status")).toContain("Yes, it went through: 0.1 TSLA to Alex.");
  });

  it("says when they don't hold enough, with the faucet", async () => {
    await giveJeremyTsla(50_000n);
    const reply = await say(JEREMY, "send @alex 0.1 TSLA");
    expect(reply).toBe(
      `You have 0.05 TSLA on Robinhood Chain testnet, not enough for that one. Free test stock tokens: faucet.testnet.chain.robinhood.com to ${await walletOf(JEREMY)}`,
    );
  });

  it("checks the balance again at approval", async () => {
    await giveJeremyTsla(5_000_000n);
    const ask = await say(JEREMY, "send @alex 1 TSLA");
    tsla.balances.set(await walletOf(JEREMY), 0n);
    await say(JEREMY, codeIn(ask));
    expect(sms.last(JEREMY)).toBe("You only have 0 TSLA now, so I didn't send it. Nothing moved.");
    expect(tsla.settled).toEqual([]);
  });

  it("applies no dollar caps, and stock sends don't count toward the daily dollar cap", async () => {
    await giveJeremyTsla(500_000_000n);
    // 60 shares is over the $50 per-payment cap if it were dollars. It isn't: testnet stocks have no price.
    await say(JEREMY, codeIn(await say(JEREMY, "send @alex 60 TSLA")));
    expect(tsla.settled).toHaveLength(1);
    const jeremy = await findUserByPhone(db, JEREMY);
    expect(await sentSince(db, jeremy!.id, new Date("2026-10-09T00:00:00Z"))).toBe(0n);
    expect(await say(JEREMY, "send @alex $40 on robinhood")).toMatch(/^Send \$40 USDC to @alex on Robinhood Chain\?/);
  });

  it("refuses dollar amounts: testnet has no stock price, and never makes one up", async () => {
    expect(await say(JEREMY, "send @alex $5 of TSLA")).toBe(
      `Robinhood Chain testnet has no price for TSLA, so I can't send a dollar amount of it. Send shares instead, like "send @alex 0.1 TSLA".`,
    );
    expect(tsla.settled).toEqual([]);
  });

  it("names the stock tokens there are", async () => {
    expect(await say(JEREMY, "send @alex 1 AAPL")).toBe(
      "AAPL isn't a stock token on Robinhood Chain testnet. You can send TSLA, AMZN, PLTR, NFLX, AMD.",
    );
    expect(await say(JEREMY, "send @alex 1 TSLA on base")).toBe(
      `Stock tokens live on Robinhood Chain testnet, not Base. Leave off "on Base".`,
    );
  });

  it("picks the chain whose asset list has the ticker, not the first chain that carries assets", async () => {
    const other: AssetTransfers = {
      list: () => [{ symbol: "XYZ", name: "Other", address: "0x00000000000000000000000000000000000000aa", decimals: 18 }],
      balanceOf: async () => 9_000_000n,
      transfer: async () => {
        throw new Error("wrong chain");
      },
    };
    deps = { ...deps, adapters: { base: { ...fakeAdapter({ chain: "base" }), assets: other }, ...deps.adapters } };
    await giveJeremyTsla(5_000_000n);
    await say(JEREMY, codeIn(await say(JEREMY, "send @alex 0.1 TSLA")));
    expect(tsla.settled).toHaveLength(1);
    expect(await say(JEREMY, "send @alex 1 AAPL")).toMatch(/^AAPL isn't a stock token on /);
  });

  it("says when Robinhood Chain is off", async () => {
    deps = { ...deps, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) } };
    expect(await say(JEREMY, "send @alex 0.1 TSLA")).toBe("Stock tokens need Robinhood Chain, which isn't switched on yet.");
    expect(await say(JEREMY, "stocks")).toBe("Stock tokens need Robinhood Chain, which isn't switched on yet.");
  });

  it("treats a repeat as the same gift, and never mistakes 0.1 TSLA for $0.10", async () => {
    await giveJeremyTsla(5_000_000n);
    await say(JEREMY, "send @alex 0.1 TSLA");
    expect(await say(JEREMY, "send @alex 0.1 TSLA")).toMatch(/^You already asked to send 0\.1 TSLA to @alex\. Reply \d{6} to confirm that one, or NEW/);
    expect(await say(JEREMY, "send @alex $0.10 on robinhood")).toMatch(/^Send \$0\.10 USDC to @alex on Robinhood Chain\?/);
  });

  it("holds a gift for someone not on Dial yet, then they claim it by text", async () => {
    await giveJeremyTsla(5_000_000n);
    const ask = await say(JEREMY, "send +1 555 000 0099 0.5 TSLA");
    expect(ask).toMatch(/^Send 0\.5 TSLA to /);
    const id = intentIdIn(ask);
    await say(JEREMY, codeIn(ask));

    const escrowed = await getIntent(db, id);
    expect(escrowed?.status).toBe("escrowed");
    expect(escrowed?.escrowSecretEnc).not.toBeNull();
    expect(tsla.settled[0]).toMatchObject({ to: escrowed?.recipientAddress, amount: 500_000n });
    expect(sms.last(NEWBIE)).toMatch(/^You got money! Jeremy sent you 0\.5 TSLA \(a test stock token\) using Dial Up Banking, the revolutionary new way to send money by text\. Reply YES to get it\./);

    await say(NEWBIE, "yes");

    expect(tsla.settled[1]).toMatchObject({ to: await walletOf(NEWBIE), amount: 500_000n, memo: id });
    expect(sms.to(NEWBIE)).toContain(
      `You got money! 0.5 TSLA from Jeremy is in your Dial wallet now, nothing to set up. Receipt: https://explorer.testnet.chain.robinhood.com/tx/0xTSLA_${id}`,
    );
    expect(sms.last(JEREMY)).toBe("+•••••••0099 claimed the 0.5 TSLA you sent.");
  });

  it("shows shares on the receipt page, the share card and the ledger, and no dollars in the stats", async () => {
    await giveJeremyTsla(5_000_000n);
    const ask = await say(JEREMY, "send @alex 0.1 TSLA");
    await say(JEREMY, codeIn(ask));
    const intent = await getIntent(db, intentIdIn(ask));
    const view = await buildPaymentView(db, intent!, deps.now(), { network: "testnet", audience: "public" });
    expect(view.stock).toBe("TSLA");
    expect(cardAmount(view)).toBe("0.1 TSLA");
    expect((await recentPayments(db, 5))[0]).toMatchObject({ stock: "TSLA", amount: 100_000n });
    expect(await publicStats(db)).toMatchObject({ payments: 1, movedUsd: 0n });
  });
});

describe("stocks over MCP", () => {
  let rpcId = 0;

  async function connectAgent(phone: string): Promise<string> {
    const reply = await say(phone, "connect agent");
    const token = /\/k\/([\w-]+)/.exec(reply)?.[1] ?? "";
    const code = /enter (\d{6})/.exec(reply)?.[1] ?? "";
    const r = await redeemAgentLink(db, token, code, deps.now());
    if (!r.ok) throw new Error(`redeem failed: ${r.reason}`);
    return r.key;
  }

  async function call(key: string, name: string, args: Record<string, unknown> = {}) {
    const res = await handleMcpRequest(
      deps,
      new Request("https://tmc.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    const body = JSON.parse(await res.text()) as {
      result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
    };
    const r = body.result;
    const text = r.content[0]?.text ?? "{}";
    const data = r.structuredContent ?? (text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : { text });
    return { isError: r.isError === true, data };
  }

  it("get_stocks lists holdings in shares, with no prices", async () => {
    const key = await connectAgent(JEREMY);
    await giveJeremyTsla(2_500_000n);
    const r = await call(key, "get_stocks");
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      chains: [
        {
          chain: "robinhood",
          network: "Robinhood Chain testnet",
          address: await walletOf(JEREMY),
          holdings: [{ symbol: "TSLA", name: "Tesla", token: TSLA, shares: "2.5" }],
          sendable: ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"],
        },
      ],
      prices: null,
    });
  });

  it("send_stock starts a gift the owner approves by text", async () => {
    const key = await connectAgent(JEREMY);
    await giveJeremyTsla(5_000_000n);
    const r = await call(key, "send_stock", { to: "@alex", shares: "0.1", symbol: "$tsla", note: "congrats" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: "awaiting_approval", kind: "send", amountUsd: null, shares: "0.1", asset: "TSLA", chain: "robinhood" });
    const text = sms.last(JEREMY);
    expect(text).toMatch(/^From your agent "agent": Send 0\.1 TSLA to @alex \(congrats\) on Robinhood Chain\? Reply \d{6}/);

    await say(JEREMY, codeIn(text));
    expect(tsla.settled).toHaveLength(1);
    const after = await call(key, "get_payment", { intentId: r.data.intentId });
    expect(after.data).toMatchObject({ status: "settled", shares: "0.1", asset: "TSLA", amountUsd: null });
  });

  it("send_stock takes shares only", async () => {
    const key = await connectAgent(JEREMY);
    const r = await call(key, "send_stock", { to: "@alex", shares: "$5", symbol: "TSLA" });
    expect(r.isError).toBe(true);
    const unknown = await call(key, "send_stock", { to: "@alex", shares: "1", symbol: "AAPL" });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.data)).toContain("unknown_asset");
  });
});

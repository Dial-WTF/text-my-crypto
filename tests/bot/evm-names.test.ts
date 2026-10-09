import { beforeEach, describe, expect, it } from "vitest";
import { redeemAgentLink } from "@/lib/agents/keys";
import { handleMcpRequest } from "@/lib/agents/mcp";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { getIntent } from "@/lib/intents";
import type { NameService } from "@/lib/settlement/capabilities";
import { buildPaymentView } from "@/lib/views/payment";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ALICE = "0x14a57643bA0A287F9D2821152ee6b37A80a7bb79";
const OTHER = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEbb";

/** ENS and Basenames services over one fixed table, counting lookups. `down` makes every lookup fail to reach the chain. */
function fakeNames(table: Record<string, string>) {
  const state = { table, calls: [] as string[], down: false };
  const service = (suffixes: string[]): NameService => ({
    suffixes,
    async resolve(name) {
      state.calls.push(name);
      if (state.down) throw new Error("rpc timeout");
      return state.table[name.toLowerCase()] ?? null;
    },
  });
  return { ...state, state, ens: service([".eth"]), base: service([".basetest.eth", ".base.eth"]) };
}

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let eth: FakeAdapter;
let base: FakeAdapter;
let names: ReturnType<typeof fakeNames>;
let k = 0;

const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `k${++k}` });
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  names = fakeNames({ "vitalik.eth": VITALIK, "alice.basetest.eth": ALICE });
  // Enabled EVM chains carry their name service as a capability; deps.names has them all, on or off.
  eth = { ...fakeAdapter({ chain: "ethereum", defaultBalance: 100_000_000n }), names: names.ens };
  base = { ...fakeAdapter({ chain: "base", defaultBalance: 100_000_000n }), names: names.base };
  deps = testDeps(db, {
    sendSms: sms.sendSms,
    adapters: { solana: sol, ethereum: eth, base },
    names: { ethereum: names.ens, base: names.base },
  });
  await say(ALEX, "hi");
  await say(ALEX, "alex");
});

describe("withdrawing to an ENS name or Basename over SMS", () => {
  it("resolves an ENS name on Ethereum and shows the name with the address it approves", async () => {
    const confirm = await say(ALEX, "withdraw $5 to vitalik.eth");
    expect(confirm).toMatch(/^Withdraw \$5 USDC to vitalik\.eth \(0xd8dA…6045\) on Ethereum\? Reply \d{6} to confirm, or tap: /);
    const intent = await getIntent(db, intentIdIn(confirm));
    expect(intent).toMatchObject({ kind: "withdraw", chain: "ethereum", recipientAddress: VITALIK, recipientName: "vitalik.eth" });
  });

  it("settles to the address stored at creation and never resolves again", async () => {
    const confirm = await say(ALEX, "withdraw $5 to vitalik.eth");
    // The name moves to someone else between the confirmation and the code.
    names.state.table["vitalik.eth"] = OTHER;
    await say(ALEX, codeIn(confirm));
    expect(eth.settled.at(-1)).toMatchObject({ to: VITALIK, amount: 5_000_000n });
    expect(names.state.calls).toEqual(["vitalik.eth"]);
    expect(sms.last(ALEX)).toMatch(/^Withdrew \$5 to vitalik\.eth \(0xd8dA…6045\)\. Receipt: /);
  });

  it("sends a Basename to Base", async () => {
    const confirm = await say(ALEX, "withdraw $20 to alice.basetest.eth");
    expect(confirm).toMatch(/^Withdraw \$20 USDC to alice\.basetest\.eth \(0x14a5…bb79\) on Base\? Reply \d{6}/);
    expect(await getIntent(db, intentIdIn(confirm))).toMatchObject({ chain: "base", recipientAddress: ALICE });
  });

  it("uses the chain they name over the one the name picks", async () => {
    const arb = fakeAdapter({ chain: "arbitrum", defaultBalance: 100_000_000n });
    deps = { ...deps, adapters: { ...deps.adapters, arbitrum: arb } };
    const confirm = await say(ALEX, "withdraw $5 to vitalik.eth on arbitrum");
    expect(confirm).toMatch(/^Withdraw \$5 USDC to vitalik\.eth \(0xd8dA…6045\) on Arbitrum\? /);
    expect(await getIntent(db, intentIdIn(confirm))).toMatchObject({ chain: "arbitrum", recipientAddress: VITALIK });
  });

  it("says when a name doesn't resolve", async () => {
    expect(await say(ALEX, "withdraw $5 to nobody-here.eth")).toBe(
      "nobody-here.eth doesn't point to an address on Ethereum Sepolia. Check the name and try again.",
    );
    expect(await say(ALEX, "withdraw $5 to jesse.base.eth")).toBe(
      "jesse.base.eth doesn't resolve on Base Sepolia. Test Basenames end in .basetest.eth.",
    );
  });

  it("says a name isn't found when no chain has a name service", async () => {
    deps = { ...deps, adapters: { solana: sol }, names: {} };
    expect(await say(ALEX, "withdraw $5 to vitalik.eth")).toBe("vitalik.eth doesn't point to an address. Check the name and try again.");
  });

  it("resolves even when Base is off, then says Base isn't switched on", async () => {
    deps = { ...deps, adapters: { solana: sol, ethereum: eth } };
    expect(await say(ALEX, "withdraw $5 to alice.basetest.eth")).toBe("Base isn't switched on yet. Try Solana.");
    expect(names.state.calls).toEqual(["alice.basetest.eth"]);
  });

  it("says so when the lookup can't reach the chain, and nothing is created", async () => {
    names.state.down = true;
    expect(await say(ALEX, "withdraw $5 to vitalik.eth")).toBe(
      "I couldn't look up vitalik.eth right now. Nothing moved. Try again in a minute.",
    );
    expect(eth.settled).toHaveLength(0);
  });

  it("shows the name on the approval page", async () => {
    const confirm = await say(ALEX, "withdraw $5 to vitalik.eth");
    const intent = (await getIntent(db, intentIdIn(confirm)))!;
    const view = await buildPaymentView(db, intent, deps.now(), { network: "testnet", audience: "party" });
    expect(view.to).toBe("vitalik.eth (0xd8dA…6045)");
  });
});

describe("withdraw tool with a name", () => {
  async function agentKey(): Promise<string> {
    const reply = await say(ALEX, "connect agent");
    const token = /\/k\/([\w-]+)/.exec(reply)?.[1] ?? "";
    const code = /enter (\d{6})/.exec(reply)?.[1] ?? "";
    const r = await redeemAgentLink(db, token, code, deps.now());
    if (!r.ok) throw new Error(`redeem failed: ${r.reason}`);
    return r.key;
  }

  async function withdraw(key: string, args: Record<string, unknown>) {
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
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "withdraw", arguments: args } }),
      }),
    );
    const { result } = JSON.parse(await res.text()) as {
      result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
    };
    const text = result.content[0]?.text ?? "{}";
    const data = result.structuredContent ?? (text.startsWith("{") ? JSON.parse(text) : { text });
    return { isError: result.isError === true, data: data as Record<string, unknown> };
  }

  it("resolves the name and returns the address it will pay", async () => {
    const key = await agentKey();
    const r = await withdraw(key, { amountUsd: "5", address: "vitalik.eth" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ chain: "ethereum", toAddress: VITALIK, toName: "vitalik.eth" });
    expect(sms.last(ALEX)).toMatch(/Withdraw \$5 USDC to vitalik\.eth \(0xd8dA…6045\) on Ethereum\?/);
  });

  it("reports a name that doesn't resolve", async () => {
    const key = await agentKey();
    const r = await withdraw(key, { amountUsd: "5", address: "nobody-here.eth" });
    expect(r).toMatchObject({ isError: true, data: { error: "unknown_name" } });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { handleMcpRequest } from "@/lib/agents/mcp";
import { handleInbound } from "@/lib/bot/handle-inbound";
import { approveIntent } from "@/lib/bot/settle";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { getIntent } from "@/lib/intents";
import { redeemAgentLink } from "@/lib/agents/keys";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let k = 0;
let rpcId = 0;

const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `k${++k}` });
  return sms.last(from);
};

async function signUp(phone: string, name: string) {
  await say(phone, "hi");
  await say(phone, name);
}

/** The full SMS issuance flow: "connect agent" → link + code → key. */
async function connectAgent(phone: string, label?: string): Promise<string> {
  const reply = await say(phone, label ? `connect agent ${label}` : "connect agent");
  const token = /\/k\/([\w-]+)/.exec(reply)?.[1] ?? "";
  const code = /enter (\d{6})/.exec(reply)?.[1] ?? "";
  const r = await redeemAgentLink(db, token, code, deps.now());
  if (!r.ok) throw new Error(`redeem failed: ${r.reason}`);
  return r.key;
}

type RpcResponse = { status: number; body: { result?: Record<string, unknown>; error?: { code: number; message: string } } };

async function rpc(key: string | null, method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await handleMcpRequest(
    deps,
    new Request("https://tmc.test/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
    }),
  );
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : {} };
}

async function call(key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(key, "tools/call", { name, arguments: args });
  const result = r.body.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
  const text = result.content[0]?.text ?? "{}";
  const data = result.structuredContent ?? (text.startsWith("{") ? JSON.parse(text) : { text });
  return { isError: result.isError === true, data: data as Record<string, unknown> };
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol } });
  await signUp(ALEX, "alex");
  await signUp(JEREMY, "jeremy");
});

describe("MCP over Streamable HTTP", () => {
  it("rejects requests without a valid agent key", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("dial_ak_not-a-real-key", "tools/list")).status).toBe(401);
    expect((await rpc(`dial_ak_${"x".repeat(43)}`, "tools/list")).status).toBe(401);
  });

  it("initializes and lists the tools", async () => {
    const key = await connectAgent(ALEX);
    const init = await rpc(key, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result?.serverInfo).toMatchObject({ name: "dial-operator" });

    const list = await rpc(key, "tools/list");
    const tools = (list.body.result?.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>) ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_invoice",
        "get_balance",
        "get_hyperliquid_balance",
        "get_pay_link",
        "get_payment",
        "get_price",
        "get_receive_address",
        "get_stocks",
        "get_wallet",
        "list_chain_features",
        "list_payments",
        "request_payment",
        "resolve_recipient",
        "send_payment",
        "send_stock",
        "send_to_hyperliquid",
        "split_payment",
        "whoami",
        "withdraw",
      ].sort(),
    );
    expect(Object.keys(tools.find((t) => t.name === "send_payment")?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["to", "amountUsd", "note", "chain"]),
    );
  });

  it("send_payment texts the owner a code, stays pending, and get_payment tracks it to settled", async () => {
    const key = await connectAgent(ALEX, "claude");
    const sent = await call(key, "send_payment", { to: "@jeremy", amountUsd: "5", note: "lunch" });
    expect(sent.isError).toBe(false);
    expect(sent.data).toMatchObject({ status: "awaiting_approval", approver: "you", amountUsd: "5", chain: "solana" });
    const intentId = String(sent.data.intentId);
    expect(sent.data.approveUrl).toBe(`https://tmc.test/a/${intentId}`);

    const ownerText = sms.last(ALEX);
    expect(ownerText).toMatch(
      new RegExp(`^From your agent "claude": Send \\$5 USDC to @jeremy \\(lunch\\) on Solana\\? Reply \\d{6} to confirm, or tap: https://tmc.test/a/${intentId}$`),
    );
    expect((await getIntent(db, intentId))?.status).toBe("pending");
    expect(sol.settled).toHaveLength(0);

    expect((await call(key, "get_payment", { intentId })).data).toMatchObject({ status: "awaiting_approval", to: "jeremy" });

    // Only the human's code moves money.
    const code = /Reply (\d{6})/.exec(ownerText)?.[1] ?? "";
    await say(ALEX, code);
    const after = await call(key, "get_payment", { intentId });
    expect(after.data).toMatchObject({ status: "settled", txHash: expect.stringContaining(intentId) });
    expect(sol.settled).toHaveLength(1);
  });

  it("has no way to approve: tools can't settle, and approval still needs the code", async () => {
    const key = await connectAgent(ALEX);
    const sent = await call(key, "send_payment", { to: "+15550000011", amountUsd: "3" });
    const intentId = String(sent.data.intentId);
    const list = await rpc(key, "tools/list");
    const names = ((list.body.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(names.some((n) => /approve|confirm|settle/.test(n))).toBe(false);
    expect((await getIntent(db, intentId))?.status).toBe("pending");
    // The texted code is the approval; approving directly still works for the human path.
    expect((await approveIntent(deps, intentId)).ok).toBe(true);
  });

  it("request_payment texts the payer and gives the owner a heads-up", async () => {
    const key = await connectAgent(ALEX, "claude");
    const r = await call(key, "request_payment", { from: "@jeremy", amountUsd: "25", note: "pizza" });
    expect(r.data).toMatchObject({ status: "awaiting_approval", approver: "@jeremy", kind: "request" });
    expect(sms.last(JEREMY)).toMatch(/^alex is asking you for \$25 USDC \(pizza\)\. Reply \d{6} to pay or NO to decline/);
    expect(sms.last(ALEX)).toBe('From your agent "claude": Asked @jeremy for $25. I\'ll text you when they pay.');
  });

  it("returns validation and business errors as tool errors without creating anything", async () => {
    const key = await connectAgent(ALEX);
    const before = sms.sent.length;
    const bad = await call(key, "send_payment", { to: "@jeremy", amountUsd: "five" });
    expect(bad.isError).toBe(true);
    expect(String(bad.data.text)).toMatch(/amountUsd/);
    expect((await call(key, "send_payment", { amountUsd: "5" })).isError).toBe(true);
    expect((await call(key, "send_payment", { to: "@jeremy", amountUsd: "500" })).data).toMatchObject({
      error: "over_cap",
    });
    expect((await call(key, "send_payment", { to: "bob", amountUsd: "5" })).data).toMatchObject({
      error: "unknown_recipient",
    });
    expect((await call(key, "send_payment", { to: "@alex", amountUsd: "5" })).data).toMatchObject({ error: "self" });
    expect(sms.sent.length).toBe(before);
  });

  it("scopes payments to the key's account", async () => {
    const alexKey = await connectAgent(ALEX);
    const jeremyKey = await connectAgent(JEREMY);
    const sent = await call(alexKey, "send_payment", { to: "@jeremy", amountUsd: "1" });
    const otherCall = await call(jeremyKey, "get_payment", { intentId: String(sent.data.intentId) });
    // jeremy is the payee, so he can see it.
    expect(otherCall.isError).toBe(false);

    await signUp("+15550000012", "sam");
    const samKey = await connectAgent("+15550000012");
    expect((await call(samKey, "get_payment", { intentId: String(sent.data.intentId) })).data).toMatchObject({
      error: "not_found",
    });
    expect(((await call(samKey, "list_payments")).data.payments as unknown[]).length).toBe(0);
    expect(((await call(alexKey, "list_payments")).data.payments as unknown[]).length).toBe(1);
  });

  it("reports whoami, balance and receive address", async () => {
    const key = await connectAgent(ALEX, "claude");
    expect((await call(key, "whoami")).data).toMatchObject({
      handle: "alex",
      phone: "+•••••••0010",
      chains: ["solana"],
      passkey: false,
      limits: { perPaymentUsd: "50", perDayUsd: "200", passkeyRequiredAboveUsd: "20" },
      agent: { label: "claude" },
    });
    expect((await call(key, "get_balance")).data).toMatchObject({
      balances: [{ chain: "solana", amountUsd: "100" }],
      totalUsd: "100",
    });
    const recv = await call(key, "get_receive_address");
    expect(recv.data).toMatchObject({ handle: "alex", addresses: [{ chain: "solana" }] });
  });

  it("hands out pay links for the owner or anyone on Dial, and the owner's wallet", async () => {
    const key = await connectAgent(ALEX);
    expect((await call(key, "get_pay_link", { handle: "@jeremy", amountUsd: "5", note: "pizza" })).data).toMatchObject({
      handle: "jeremy",
      url: "https://tmc.test/@jeremy?amount=5&note=pizza",
      byText: { body: "send @jeremy $5 for pizza" },
      chains: [{ chain: "solana" }],
    });
    expect((await call(key, "get_pay_link")).data).toMatchObject({ handle: "alex", url: "https://tmc.test/@alex" });
    expect((await call(key, "get_pay_link", { handle: "@nobody" })).data).toMatchObject({ error: "not_found" });
    expect((await call(key, "get_wallet")).data).toMatchObject({ handle: "alex", chains: [{ chain: "solana", balanceUsd: "100" }] });
  });

  it("resolve_recipient reads without creating accounts", async () => {
    const key = await connectAgent(ALEX);
    expect((await call(key, "resolve_recipient", { to: "@jeremy" })).data).toMatchObject({ found: true, onDial: true });
    expect((await call(key, "resolve_recipient", { to: "+1 555 000 0099" })).data).toMatchObject({
      found: true,
      onDial: false,
      via: "phone",
    });
    expect((await call(key, "resolve_recipient", { to: "@nobody" })).data).toMatchObject({ error: "unknown_handle" });
    expect((await call(key, "resolve_recipient", { to: "bob" })).data).toMatchObject({ error: "unknown_recipient" });
  });

  it("stops working after the owner texts revoke agents", async () => {
    const key = await connectAgent(ALEX);
    expect((await rpc(key, "tools/list")).status).toBe(200);
    expect(await say(ALEX, "revoke agents")).toBe('Revoked 1 agent key. Text "connect agent" to connect one again.');
    expect((await rpc(key, "tools/list")).status).toBe(401);
  });

  it("finds people in the directory, and asks which one when a name is ambiguous", async () => {
    const key = await connectAgent(ALEX);
    expect((await call(key, "resolve_recipient", { to: "jeremy" })).data).toMatchObject({ found: true, via: "directory" });
    await signUp("+15550000013", "jeremiah");
    const before = sms.sent.length;
    const r = await call(key, "send_payment", { to: "jere", amountUsd: "5" });
    expect(r.data).toMatchObject({ error: "ambiguous_recipient" });
    expect(String(r.data.message)).toMatch(/@jeremy.*@jeremiah|@jeremiah.*@jeremy/);
    expect((await call(key, "resolve_recipient", { to: "jere" })).data).toMatchObject({ error: "ambiguous_recipient" });
    expect(sms.sent.length).toBe(before);
  });

  it("won't start the same payment twice while one is waiting", async () => {
    const key = await connectAgent(ALEX);
    const first = await call(key, "send_payment", { to: "@jeremy", amountUsd: "4" });
    const texts = sms.sent.length;
    const again = await call(key, "send_payment", { to: "@jeremy", amountUsd: "4" });
    expect(again.data).toMatchObject({ error: "duplicate" });
    expect(String(again.data.message)).toContain(String(first.data.intentId));
    expect(sms.sent.length).toBe(texts);
    expect((await call(key, "send_payment", { to: "@jeremy", amountUsd: "4.01" })).isError).toBe(false);
  });

  it("tells the agent when the owner has paused texts", async () => {
    const key = await connectAgent(ALEX);
    await say(ALEX, "STOP");
    const texts = sms.sent.length;
    const r = await call(key, "send_payment", { to: "@jeremy", amountUsd: "3" });
    expect(r.data).toMatchObject({ status: "awaiting_approval" });
    expect(String(r.data.message)).toMatch(/paused texts/);
    expect(sms.sent.length).toBe(texts);
  });

  it("hides chain failures behind a plain tool error", async () => {
    const key = await connectAgent(ALEX);
    sol.getBalance = async () => {
      throw new Error("Solana error #8100002 with internal detail");
    };
    const r = await call(key, "get_balance");
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ error: "unavailable", message: "Dial couldn't finish that just now. Try again in a minute." });
  });

  it("only takes POST", async () => {
    const key = await connectAgent(ALEX);
    const res = await handleMcpRequest(
      deps,
      new Request("https://tmc.test/api/mcp", { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(405);
  });

  it("rate-limits money tools per key", async () => {
    const key = await connectAgent(ALEX);
    for (let i = 1; i <= 20; i++) {
      expect((await call(key, "request_payment", { from: "@jeremy", amountUsd: String(i) })).isError).toBe(false);
    }
    expect((await call(key, "request_payment", { from: "@jeremy", amountUsd: "21" })).data).toMatchObject({
      error: "rate_limited",
    });
    // Reads still work.
    expect((await call(key, "whoami")).isError).toBe(false);
  });
});

describe("send_payment with private: true", () => {
  it("starts a shielded Zcash send, whatever the owner's default chain", async () => {
    deps.adapters.zcash = { ...fakeAdapter({ chain: "zcash", defaultBalance: 5_000_000n }), shielded: { pool: "Ironwood", byDefault: true } };
    const key = await connectAgent(ALEX);
    const r = await call(key, "send_payment", { to: "@jeremy", amountUsd: "1", private: true });
    expect(r.isError).toBe(false);
    const intent = await getIntent(db, String(r.data.intentId));
    expect(intent).toMatchObject({ chain: "zcash", private: true });
    expect(sms.last(ALEX)).toContain("privately? It goes shielded on Zcash");
  });

  it("says private sends aren't on when Zcash isn't switched on", async () => {
    const key = await connectAgent(ALEX);
    const r = await call(key, "send_payment", { to: "@jeremy", amountUsd: "1", private: true });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.data)).toContain("Private sends need a chain with a shielded pool");
  });
});

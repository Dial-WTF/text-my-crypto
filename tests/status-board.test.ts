import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { watchdogProblems } from "@/lib/db/schema";
import { type Check, LLM_SAMPLE, llmCheck } from "@/lib/health";
import { networkName } from "@/lib/ledger";
import type { LlmResult } from "@/lib/operator/brain";
import { overall } from "@/lib/public-status";
import { logInbound, logOutbound } from "@/lib/sms/log";
import { type BoardDeps, lastAnsweredAt, loadBoard, programCheck } from "@/lib/status-board";
import { LAST_RUN_KEY, markRun } from "@/lib/watchdog/problems";
import { createTestDb } from "./helpers/db";

const ALEX = "+15550000010";
const SAM = "+15550000011";
const LINE = "+15550000001";
const T0 = new Date("2026-10-09T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ok: Check = { ok: true, ms: 20 };

let db: Db;

function deps(over: Partial<BoardDeps> = {}): BoardDeps {
  return {
    db,
    now: T0,
    dependencies: async () => ({ d1: ok, payphoneAuth: ok, solanaBalance: ok }),
    networkName: (chain) => networkName(chain, "testnet"),
    llm: async () => ok,
    escrow: null,
    ...over,
  };
}

const row = async (name: string, over: Partial<BoardDeps> = {}) => (await loadBoard(deps(over))).rows.find((r) => r.name === name);

async function inbound(phone: string, minutes: number, key: string) {
  await logInbound(db, { to: LINE, from: phone, body: "balance", dedupeKey: key }, at(minutes));
}

async function problem(key: string, p: { started: number; resolved?: number; alerted?: number }) {
  await db.insert(watchdogProblems).values({
    key,
    detail: `1 text with no reply (${ALEX}) via https://rpc.example/v2/secretkey`,
    failures: 2,
    firstSeenAt: at(p.started),
    lastAlertedAt: p.alerted === undefined ? null : at(p.alerted),
    resolvedAt: p.resolved === undefined ? null : at(p.resolved),
  });
}

beforeEach(async () => {
  db = await createTestDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("texting", () => {
  it("says when the last text was answered, rounded, and ignores texts nobody sent first", async () => {
    expect(await row("Last text answered")).toMatchObject({ state: null, value: "none yet" });
    await logOutbound(db, SAM, "Alex sent you $5", at(-1));
    expect(await lastAnsweredAt(db)).toBeNull();

    await inbound(ALEX, -12, "k1");
    await logOutbound(db, ALEX, "You have $1.00", at(-11.5));
    expect(await row("Last text answered")).toMatchObject({ state: null, value: "11 min ago" });
    await logOutbound(db, SAM, "Alex sent you $5", at(-0.2));
    expect(await row("Last text answered")).toMatchObject({ value: "11 min ago" });
  });

  it("counts texts waiting over a minute: slow while young, down past five minutes", async () => {
    expect(await row("Texts waiting for a reply")).toMatchObject({ state: "ok", value: "0" });
    await inbound(ALEX, -0.5, "k1");
    expect(await row("Texts waiting for a reply")).toMatchObject({ state: "ok", value: "0" });
    await inbound(SAM, -2, "k2");
    expect(await row("Texts waiting for a reply")).toMatchObject({ state: "slow", value: "1" });
    await inbound(ALEX, -6, "k3");
    expect(await row("Texts waiting for a reply")).toMatchObject({ state: "down", value: "2" });
    await logOutbound(db, ALEX, "You have $1.00", at(-0.1));
    await logOutbound(db, SAM, "You have $1.00", at(-0.1));
    expect(await row("Texts waiting for a reply")).toMatchObject({ state: "ok", value: "0" });
  });
});

describe("watchdog", () => {
  it("says how long ago it last ran: ok within three minutes, slow within ten, down after or never", async () => {
    expect(await row("Last watchdog run")).toMatchObject({ state: "down", value: "never" });
    await markRun(db, at(-2));
    expect(await row("Last watchdog run")).toMatchObject({ state: "ok", value: "2 min ago" });
    await markRun(db, at(-7));
    expect(await row("Last watchdog run")).toMatchObject({ state: "slow", value: "7 min ago" });
    await markRun(db, at(-90));
    expect(await row("Last watchdog run")).toMatchObject({ state: "down", value: "1 hour ago" });
  });

  it("lists open problems by their plain labels only, and never the run marker", async () => {
    await markRun(db, at(-1));
    expect(await row("Open problems")).toMatchObject({ state: "ok", value: "none" });
    await problem("undelivered", { started: -3 });
    await problem("solanaBalance", { started: -4 });
    await problem("someInternalThing", { started: -1 });
    const board = await loadBoard(deps());
    expect(board.rows.find((r) => r.name === "Open problems")).toMatchObject({ state: "slow", value: "3" });
    expect(board.problems).toEqual([
      "Payphone got a text but never passed it to the bot",
      "Solana network not answering",
      "Another check is failing",
    ]);
    expect(JSON.stringify(board)).not.toContain(LAST_RUN_KEY);
    expect(JSON.stringify(board)).not.toContain("someInternalThing");
  });

  it("calls open problems down once the watchdog alerted on them", async () => {
    await problem("unanswered", { started: -6, alerted: -5 });
    expect(await row("Open problems")).toMatchObject({ state: "down", value: "1" });
  });
});

describe("incidents", () => {
  it("lists alerted incidents from the last day, newest first, at most five, with rounded times", async () => {
    await problem("d1", { started: -30, alerted: -29, resolved: -20 });
    await problem("unanswered", { started: -125, alerted: -124, resolved: -118 });
    await problem("solanaBalance", { started: -3, alerted: -2 });
    await problem("tempoBalance", { started: -2, resolved: -1 }); // a blip: never alerted
    await problem("llm", { started: -3000, alerted: -2999, resolved: -2000 }); // over a day ago
    const { incidents } = await loadBoard(deps());
    expect(incidents).toEqual([
      { label: "Solana network not answering", open: true, started: "3 min ago", resolved: null },
      { label: "Database unreachable", open: false, started: "30 min ago", resolved: "20 min ago" },
      { label: "A text got no reply", open: false, started: "2 hours ago", resolved: "1 hour ago" },
    ]);
  });

  it("keeps the five newest", async () => {
    for (const [i, key] of ["d1", "llm", "app", "unanswered", "undelivered", "payphoneAuth", "payphoneInbox"].entries()) {
      await problem(key, { started: -10 * (i + 1), alerted: -10 * (i + 1), resolved: -1 });
    }
    const { incidents } = await loadBoard(deps());
    expect(incidents?.map((i) => i.started)).toEqual(["10 min ago", "20 min ago", "30 min ago", "40 min ago", "50 min ago"]);
  });

  it("is an empty list with none, and null when they can't be read", async () => {
    expect((await loadBoard(deps())).incidents).toEqual([]);
    const broken = {
      select: () => {
        throw new Error("D1_ERROR: no such table");
      },
    } as unknown as Db;
    const board = await loadBoard(deps({ db: broken }));
    expect(board.incidents).toBeNull();
    expect(board.rows.find((r) => r.name === "Open problems")).toMatchObject({ state: null, value: "unknown" });
    expect(JSON.stringify(board)).not.toContain("D1_ERROR");
  });
});

describe("services", () => {
  it("adds the language model and escrow program after the core services, before the networks", async () => {
    const check = vi.fn(async () => ok);
    const board = await loadBoard(
      deps({ escrow: { address: "Prog1111", href: "https://explorer.solana.com/address/Prog1111?cluster=devnet", check } }),
    );
    expect(board.rows.filter((r) => r.kind === "service" || r.kind === "network").map((r) => r.name)).toEqual([
      "Database",
      "Texting (Payphone)",
      "Language model (Workers AI)",
      "Solana escrow program",
      "Solana devnet",
    ]);
    expect(board.rows.find((r) => r.name === "Solana escrow program")).toMatchObject({
      state: "ok",
      link: { address: "Prog1111", href: "https://explorer.solana.com/address/Prog1111?cluster=devnet" },
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("leaves the language model out when none is configured, and calls it slow only well past a normal answer", async () => {
    expect(await row("Language model (Workers AI)", { llm: async () => null })).toBeUndefined();
    expect(await row("Language model (Workers AI)", { llm: async () => ({ ok: true, ms: 3_000 }) })).toMatchObject({ state: "ok" });
    expect(await row("Language model (Workers AI)", { llm: async () => ({ ok: true, ms: 9_000 }) })).toMatchObject({ state: "slow" });
    expect(
      await row("Language model (Workers AI)", { llm: async () => ({ ok: false, ms: 50, detail: "InferenceUpstreamError 5021" }) }),
    ).toMatchObject({ state: "down" });
    expect(await row("Language model (Workers AI)", { llm: () => Promise.reject(new Error("boom")) })).toMatchObject({ state: "down" });
  });

  it("shows no service rows, so the board reads down, when the dependency checks can't run", async () => {
    const board = await loadBoard(deps({ dependencies: () => Promise.reject(new Error("env broken")) }));
    expect(board.rows.some((r) => r.kind === "service")).toBe(false);
    expect(board.rows.some((r) => r.kind === "texting")).toBe(true);
    expect(overall(board.rows)).toBe("down");
  });
});

describe("llmCheck", () => {
  const answer = (over: Partial<LlmResult> = {}): LlmResult => ({
    intent: "send",
    counterparty: "alex",
    amountUsd: "5",
    chain: null,
    note: "lunch",
    reply: "",
    ...over,
  });

  it("reads the health route's sample and passes only on send $5", async () => {
    const llm = vi.fn(async () => answer());
    expect((await llmCheck(llm)).ok).toBe(true);
    expect(llm).toHaveBeenCalledWith(LLM_SAMPLE, []);
    expect((await llmCheck(async () => answer({ amountUsd: "50" }))).ok).toBe(false);
    expect((await llmCheck(async () => answer({ intent: "chat", amountUsd: null }))).ok).toBe(false);
    expect((await llmCheck(() => Promise.reject(new Error("No language model configured")))).ok).toBe(false);
  });
});

describe("programCheck", () => {
  const rpc = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

  it("passes only for an executable program account, with one getAccountInfo call", async () => {
    const fetchImpl = rpc({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { executable: true, owner: "BPF", lamports: 1 } } });
    expect((await programCheck("https://rpc.test", "Prog1111", fetchImpl)).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as unknown;
    expect(body).toMatchObject({ method: "getAccountInfo", params: ["Prog1111", { encoding: "base64" }] });
  });

  it("fails for a missing or non-executable account, an RPC error or a bad answer", async () => {
    const cases = [
      rpc({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } }),
      rpc({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { executable: false } } }),
      rpc({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } }),
      rpc("rate limited", 429),
    ];
    for (const fetchImpl of cases) {
      expect((await programCheck("https://rpc.test", "Prog1111", fetchImpl)).ok).toBe(false);
    }
  });
});

describe("what the board never shows", () => {
  it("carries no phone numbers, problem details, hosts, keys or timings", async () => {
    await inbound(ALEX, -6, "k1");
    await inbound(SAM, -3, "k2");
    await logOutbound(db, SAM, "You have $1.00", at(-2.5));
    await problem("unanswered", { started: -6, alerted: -5 });
    await problem("tempoBalance", { started: -40, alerted: -39, resolved: -30 });
    const board = await loadBoard(
      deps({
        dependencies: async () => ({
          d1: { ok: true, ms: 1234 },
          payphoneAuth: { ok: false, ms: 300, detail: "HTTP 401 from https://payphone.example/api?key=sk_live_secret" },
          solanaBalance: { ok: true, ms: 77, detail: "1000000" },
        }),
        llm: async () => ({ ok: true, ms: 4321, detail: 'send alex 5 "lunch"' }),
        escrow: { address: "Prog1111", href: "https://explorer.solana.com/address/Prog1111?cluster=devnet", check: async () => ({ ok: false, ms: 5, detail: "https://rpc.example/v2/secretkey" }) },
      }),
    );
    const out = JSON.stringify(board);
    for (const leak of ["555", "0010", "0011", "HTTP 401", "sk_live", "payphone.example", "rpc.example", "secretkey", "1000000", "lunch", "1234", "4321", "detail", '"ms":']) {
      expect(out, leak).not.toContain(leak);
    }
  });
});

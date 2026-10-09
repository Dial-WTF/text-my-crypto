import { drizzle } from "drizzle-orm/sql-js";
import type { Database } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { watchdogProblems } from "@/lib/db/schema";
import { logInbound, logOutbound } from "@/lib/sms/log";
import { LAST_RUN_KEY } from "@/lib/watchdog/problems";
import { runWatchdog, type WatchdogDeps } from "@/lib/watchdog/run";
import { type D1Like, scheduledWatchdog } from "@/lib/watchdog/scheduled";
import { resetSlotForTests } from "@/lib/watchdog/slot";
import { createSqlite, createTestDb } from "../helpers/db";
import { fakeAdapter } from "../helpers/fakes";

const ALEX = "+15550000010";
const OWNER = "+15550000099";
const LINE = "+18066071387";
const T0 = new Date("2026-10-09T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

type Inbox = Array<{ direction: string; contact: string; body: string; timestamp: string }>;

/** Payphone stand-in: numbers/mine for auth, the inbox for reconciliation. Records every call. */
function fakePayphone(opts: { inbox?: Inbox; authStatus?: number; inboxStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/numbers/mine")) return new Response("{}", { status: opts.authStatus ?? 200 });
    if (url.includes("/sms/inbox")) {
      return opts.inboxStatus ? new Response("nope", { status: opts.inboxStatus }) : Response.json({ success: true, messages: opts.inbox ?? [] });
    }
    return new Response("unexpected", { status: 500 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

let db: Db;
let logs: string[];
let alerts: string[];
let now: Date;

function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    db,
    now: () => now,
    fetchImpl: fakePayphone().fetchImpl,
    payphone: { baseUrl: "https://pp.test", apiKey: "key", line: LINE },
    reconcile: true,
    adapters: { solana: fakeAdapter() },
    alert: async (body) => void alerts.push(body),
    ...over,
  };
}

beforeEach(async () => {
  db = await createTestDb();
  logs = [];
  alerts = [];
  now = T0;
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

describe("watchdog run", () => {
  it("passes quietly when everything is healthy, with one log line", async () => {
    const report = await runWatchdog(deps());
    expect(report.ok).toBe(true);
    expect(Object.keys(report.checks).sort()).toEqual(
      ["app", "d1", "payphoneAuth", "payphoneInbox", "solanaBalance", "unanswered", "undelivered"].sort(),
    );
    expect(alerts).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({ evt: "watchdog", ok: true, failing: [], sent: false });
  });

  it("records when it last ran, in a row no check uses and that is never open", async () => {
    await runWatchdog(deps());
    now = at(1);
    await runWatchdog(deps());
    const rows = await db.select().from(watchdogProblems);
    expect(rows).toEqual([expect.objectContaining({ key: LAST_RUN_KEY, firstSeenAt: at(1), resolvedAt: at(1), lastAlertedAt: null })]);
    expect(alerts).toEqual([]);
  });

  it("texts the owner about an unanswered text once, then the all-clear once it is answered", async () => {
    await logInbound(db, { to: LINE, from: ALEX, body: "balance", dedupeKey: "k1" }, at(-2));
    await runWatchdog(deps());
    expect(alerts).toEqual(["[Dial watchdog, for you only] Problem: a text got no reply (1 text with no reply, oldest 2m (…0010))."]);
    expect(alerts[0]).not.toContain(ALEX);

    now = at(1);
    await runWatchdog(deps());
    expect(alerts).toHaveLength(1);

    await logOutbound(db, ALEX, "You have $1.00", at(1));
    now = at(2);
    await runWatchdog(deps());
    now = at(3);
    await runWatchdog(deps());
    expect(alerts).toEqual([expect.any(String), "[Dial watchdog, for you only] Fixed: every text has a reply again."]);
  });

  it("says a text aged out of the window instead of claiming it was answered", async () => {
    await logInbound(db, { to: LINE, from: ALEX, body: "balance", dedupeKey: "k1" }, at(-2));
    await runWatchdog(deps());
    for (const m of [59, 60]) {
      now = at(m);
      await runWatchdog(deps());
    }
    expect(alerts.at(-1)).toBe("[Dial watchdog, for you only] Never fixed, now over an hour old, so no longer watched: a text got no reply.");
    expect(alerts.join(" ")).not.toContain("Fixed");
  });

  it("says an undelivered text aged out once it leaves Payphone's window", async () => {
    const inbox: Inbox = [{ direction: "inbound", contact: ALEX, body: "482913", timestamp: at(-3).toISOString() }];
    const fetchImpl = fakePayphone({ inbox }).fetchImpl;
    await runWatchdog(deps({ fetchImpl }));
    for (const m of [58, 59]) {
      now = at(m);
      await runWatchdog(deps({ fetchImpl }));
    }
    expect(alerts).toEqual([
      expect.stringContaining("Problem: Payphone got a text but never passed it to the bot"),
      "[Dial watchdog, for you only] Never fixed, now over an hour old, so no longer watched: Payphone got a text but never passed it to the bot.",
    ]);
  });

  it("skips the Payphone checks where there is no Payphone key", async () => {
    const pp = fakePayphone();
    const report = await runWatchdog(deps({ fetchImpl: pp.fetchImpl, payphone: { baseUrl: "https://pp.test", line: LINE } }));
    expect(report.checks.payphoneAuth).toBeUndefined();
    expect(report.checks.undelivered).toBeUndefined();
    expect(pp.calls).toEqual([]);
  });

  it("without D1 for alert state, alerts only on the 30-minute slot", async () => {
    resetSlotForTests();
    const broken = { ...db, select: () => { throw new Error("D1_ERROR: unavailable"); } } as unknown as Db;
    const down = fakeAdapter();
    down.getBalance = async () => {
      throw new Error("fetch failed");
    };
    for (let m = 1; m <= 61; m++) {
      now = at(m);
      await runWatchdog(deps({ db: broken, adapters: { solana: down } }));
    }
    // T0 is on a slot boundary: minutes 30 and 60 are the only slot starts in 1..61.
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain("Solana network not answering");
  });

  it("flags a text Payphone has that never reached the webhook", async () => {
    const inbox: Inbox = [
      { direction: "inbound", contact: `${ALEX}@cheogram.com`, body: "482913", timestamp: at(-3).toISOString() },
    ];
    const report = await runWatchdog(deps({ fetchImpl: fakePayphone({ inbox }).fetchImpl }));
    expect(report.checks.undelivered).toEqual({ ok: false, detail: "1 text in Payphone never reached Dial, oldest 3m (…0010)" });
    expect(alerts[0]).toContain("Payphone got a text but never passed it to the bot");
  });

  it("skips reconciliation where the line does not point at this deployment", async () => {
    const pp = fakePayphone();
    const report = await runWatchdog(deps({ reconcile: false, fetchImpl: pp.fetchImpl }));
    expect(report.checks.undelivered).toBeUndefined();
    expect(pp.calls.some((u) => u.includes("/sms/inbox"))).toBe(false);
  });

  it("waits for a second failing minute before alerting about a dependency", async () => {
    const broken = fakePayphone({ authStatus: 401 }).fetchImpl;
    await runWatchdog(deps({ fetchImpl: broken }));
    expect(alerts).toEqual([]);
    now = at(1);
    await runWatchdog(deps({ fetchImpl: broken }));
    expect(alerts).toEqual(["[Dial watchdog, for you only] Problem: Payphone login failing (HTTP 401)."]);
  });

  it("checks every chain's RPC", async () => {
    const down = fakeAdapter({ chain: "tempo" });
    down.getBalance = async () => {
      throw new Error("fetch failed");
    };
    const report = await runWatchdog(deps({ adapters: { solana: fakeAdapter(), tempo: down } }));
    expect(report.checks.tempoBalance?.ok).toBe(false);
    expect(report.checks.solanaBalance?.ok).toBe(true);
  });

  it("does not lose an alert whose text failed: the next run sends it", async () => {
    await logInbound(db, { to: LINE, from: ALEX, body: "balance", dedupeKey: "k1" }, at(-2));
    const report = await runWatchdog(
      deps({
        alert: async () => {
          throw new Error("Payphone send failed 503");
        },
      }),
    );
    expect(report.error).toContain("503");
    now = at(1);
    await runWatchdog(deps());
    expect(alerts).toHaveLength(1);
  });

  it("only logs when no owner phone is set", async () => {
    await logInbound(db, { to: LINE, from: ALEX, body: "balance", dedupeKey: "k1" }, at(-2));
    const report = await runWatchdog(deps({ alert: null }));
    expect(report).toMatchObject({ ok: false, alerted: ["unanswered"], sent: false });
    expect(JSON.parse(logs.at(-1) ?? "")).toMatchObject({ evt: "watchdog", failing: ["unanswered"] });
    expect(logs.join("\n")).not.toContain(ALEX);
  });
});

describe("cron trigger", () => {
  const env = {
    APP_URL: "https://tmc.test",
    SMS_WEBHOOK_SECRET: "s".repeat(40),
    SMS_MODE: "payphone",
    PAYPHONE_API_KEY: "key",
    PAYPHONE_BASE_URL: "https://pp.test",
    DIAL_OPERATOR_NUMBER: LINE,
    ALERT_PHONE: OWNER,
  };
  let sqlite: Database;
  let d1: D1Like;
  beforeEach(async () => {
    resetSlotForTests();
    sqlite = await createSqlite();
    db = drizzle(sqlite, { schema }) as unknown as Db;
    // D1's prepare/bind/first/run over the same SQLite the watchdog route uses.
    d1 = {
      prepare: (query) => ({
        bind: (...values) => ({
          first: async <T>() => {
            const stmt = sqlite.prepare(query);
            stmt.bind(values as never);
            const row = stmt.step() ? (stmt.getAsObject() as T) : null;
            stmt.free();
            return row;
          },
          run: async () => sqlite.run(query, values as never),
        }),
      }),
    };
  });

  function sink() {
    const sent: Array<{ to: string; message: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  }
  const broken = async () => new Response("boom", { status: 500 });

  it("runs the watchdog route and sends nothing itself when it answers", async () => {
    const seen: string[] = [];
    const s = sink();
    await scheduledWatchdog(async (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true });
    }, { ...env, DB: d1 }, { fetchImpl: s.fetchImpl });
    expect(seen).toEqual([`POST /api/sms/${env.SMS_WEBHOOK_SECRET}/watchdog`]);
    expect(s.sent).toEqual([]);
  });

  it("texts only the owner from the second failing minute, then at most every 30 minutes, across isolates", async () => {
    const s = sink();
    // A new isolate every run: nothing but D1 carries over.
    for (let m = 0; m <= 31; m++) {
      await scheduledWatchdog(broken, { ...env, DB: d1 }, { fetchImpl: s.fetchImpl, now: () => at(m).getTime() });
    }
    expect(s.sent).toEqual([
      { to: OWNER, from: LINE, message: expect.stringContaining("app: not answering (watchdog route answered 500)") },
      { to: OWNER, from: LINE, message: expect.stringContaining("not answering") },
    ]);
    const [row] = await db.select().from(watchdogProblems);
    expect(row).toMatchObject({ key: "app", failures: 32, lastAlertedAt: at(31) });
  });

  it("hands the all-clear to the watchdog route once the app answers again", async () => {
    const s = sink();
    for (const m of [0, 1]) await scheduledWatchdog(broken, { ...env, DB: d1 }, { fetchImpl: s.fetchImpl, now: () => at(m).getTime() });
    expect(s.sent).toHaveLength(1);
    for (const m of [2, 3]) {
      now = at(m);
      await runWatchdog(deps({ reconcile: false }));
    }
    expect(alerts).toEqual(["[Dial watchdog, for you only] Fixed: the bot is answering again."]);
  });

  it("without D1, texts only on the 30-minute slot", async () => {
    const s = sink();
    const noD1: D1Like = {
      prepare: () => {
        throw new Error("D1_ERROR: unavailable");
      },
    };
    for (let m = 1; m <= 61; m++) {
      await scheduledWatchdog(broken, { ...env, DB: noD1 }, { fetchImpl: s.fetchImpl, now: () => at(m).getTime() });
    }
    expect(s.sent).toHaveLength(2);
  });

  it("never texts outside production SMS mode or without an owner", async () => {
    const s = sink();
    for (const m of [0, 1, 2]) {
      const t = () => at(m).getTime();
      await scheduledWatchdog(broken, { ...env, DB: d1, SMS_MODE: "log" }, { fetchImpl: s.fetchImpl, now: t });
      await scheduledWatchdog(broken, { ...env, DB: d1, ALERT_PHONE: undefined }, { fetchImpl: s.fetchImpl, now: t });
      await scheduledWatchdog(broken, { ...env, DB: d1, ALERT_PHONE: "not a phone" }, { fetchImpl: s.fetchImpl, now: t });
    }
    expect(s.sent).toEqual([]);
  });
});

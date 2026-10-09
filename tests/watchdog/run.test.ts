import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { logInbound, logOutbound } from "@/lib/sms/log";
import { runWatchdog, type WatchdogDeps } from "@/lib/watchdog/run";
import { resetScheduledForTests, scheduledWatchdog } from "@/lib/watchdog/scheduled";
import { createTestDb } from "../helpers/db";
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
      ["d1", "payphoneAuth", "payphoneInbox", "solanaBalance", "unanswered", "undelivered"].sort(),
    );
    expect(alerts).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({ evt: "watchdog", ok: true, failing: [], sent: false });
  });

  it("texts the owner about an unanswered text once, then the all-clear once it is answered", async () => {
    await logInbound(db, { to: LINE, from: ALEX, body: "balance", dedupeKey: "k1" }, at(-2));
    await runWatchdog(deps());
    expect(alerts).toEqual(["Dial watchdog. PROBLEM: unanswered: 1 text with no reply, oldest 2m (…0010)."]);
    expect(alerts[0]).not.toContain(ALEX);

    now = at(1);
    await runWatchdog(deps());
    expect(alerts).toHaveLength(1);

    await logOutbound(db, ALEX, "You have $1.00", at(1));
    now = at(2);
    await runWatchdog(deps());
    expect(alerts).toEqual([expect.any(String), "Dial watchdog. Cleared: unanswered."]);
  });

  it("flags a text Payphone has that never reached the webhook", async () => {
    const inbox: Inbox = [
      { direction: "inbound", contact: `${ALEX}@cheogram.com`, body: "482913", timestamp: at(-3).toISOString() },
    ];
    const report = await runWatchdog(deps({ fetchImpl: fakePayphone({ inbox }).fetchImpl }));
    expect(report.checks.undelivered).toEqual({ ok: false, detail: "1 text in Payphone never reached Dial, oldest 3m (…0010)" });
    expect(alerts[0]).toContain("undelivered");
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
    expect(alerts).toEqual(["Dial watchdog. PROBLEM: payphoneAuth: HTTP 401."]);
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
  beforeEach(() => resetScheduledForTests());

  function sink() {
    const sent: Array<{ to: string; message: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  }

  it("runs the watchdog route and sends nothing itself when it answers", async () => {
    const seen: string[] = [];
    const s = sink();
    await scheduledWatchdog(async (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true });
    }, env, { fetchImpl: s.fetchImpl });
    expect(seen).toEqual([`POST /api/sms/${env.SMS_WEBHOOK_SECRET}/watchdog`]);
    expect(s.sent).toEqual([]);
  });

  it("texts only the owner when the app cannot answer, at most every 30 minutes", async () => {
    const s = sink();
    const broken = async () => new Response("boom", { status: 500 });
    let t = T0.getTime();
    await scheduledWatchdog(broken, env, { fetchImpl: s.fetchImpl, now: () => t });
    t += 29 * 60_000;
    await scheduledWatchdog(broken, env, { fetchImpl: s.fetchImpl, now: () => t });
    expect(s.sent).toEqual([expect.objectContaining({ to: OWNER, message: expect.stringContaining("answered 500") })]);
    t += 60_000;
    await scheduledWatchdog(broken, env, { fetchImpl: s.fetchImpl, now: () => t });
    expect(s.sent).toHaveLength(2);
  });

  it("never texts outside production SMS mode or without an owner", async () => {
    const s = sink();
    const broken = async () => new Response("boom", { status: 500 });
    await scheduledWatchdog(broken, { ...env, SMS_MODE: "log" }, { fetchImpl: s.fetchImpl });
    await scheduledWatchdog(broken, { ...env, ALERT_PHONE: undefined }, { fetchImpl: s.fetchImpl });
    await scheduledWatchdog(broken, { ...env, ALERT_PHONE: "not a phone" }, { fetchImpl: s.fetchImpl });
    expect(s.sent).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { watchdogProblems } from "@/lib/db/schema";
import { alertText, type CheckResult, markSent, planAlerts } from "@/lib/watchdog/problems";
import { createTestDb } from "../helpers/db";

const T0 = new Date("2026-10-09T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const failing = (key: string, alertAfter?: number): CheckResult => ({ key, ok: false, detail: `${key} broke`, alertAfter });
const passing = (key: string): CheckResult => ({ key, ok: true, detail: "ok" });
const agedOut = (key: string): CheckResult => ({ key, ok: true, agedOut: true, detail: "1 aged out" });

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

/** One run: plan, pretend the text went out, return what it said. */
async function run(results: CheckResult[], when: Date): Promise<string | null> {
  const plan = await planAlerts(db, results, when);
  const text = alertText(plan);
  if (text) await markSent(db, plan, when);
  return text;
}

/** Runs one check's results minute by minute from T0 and returns the texts sent, by minute. */
async function timeline(results: CheckResult[]): Promise<Record<number, string>> {
  const texts: Record<number, string> = {};
  for (const [m, r] of results.entries()) {
    const text = await run([r], at(m));
    if (text) texts[m] = text;
  }
  return texts;
}

describe("alert dedup", () => {
  it("alerts on the first failure, then stays quiet for 30 minutes, then reminds", async () => {
    expect(await run([failing("unanswered")], at(0))).toBe("[Dial watchdog, for you only] Problem: a text got no reply (unanswered broke).");
    for (let m = 1; m < 30; m++) expect(await run([failing("unanswered")], at(m))).toBeNull();
    expect(await run([failing("unanswered")], at(30))).toContain("Problem: a text got no reply");
  });

  it("sends one all-clear after two passing runs, and nothing after", async () => {
    await run([failing("unanswered")], at(0));
    expect(await run([passing("unanswered")], at(1))).toBeNull();
    expect(await run([passing("unanswered")], at(2))).toBe("[Dial watchdog, for you only] Fixed: every text has a reply again.");
    expect(await run([passing("unanswered")], at(3))).toBeNull();
    const [row] = await db.select().from(watchdogProblems);
    expect(row?.resolvedAt).toEqual(at(2));
  });

  it("does not clear on a single pass between failures", async () => {
    await run([failing("unanswered")], at(0));
    expect(await run([passing("unanswered")], at(1))).toBeNull();
    expect(await run([failing("unanswered")], at(2))).toBeNull();
    expect(await run([passing("unanswered")], at(3))).toBeNull();
    expect(await run([passing("unanswered")], at(4))).toBe("[Dial watchdog, for you only] Fixed: every text has a reply again.");
  });

  it("texts a flapping check at most one PROBLEM and one all-clear per 30 minutes", async () => {
    // fail, pass, pass, fail, pass, pass, ... for an hour: the window counts from the last alert.
    const flaps = Array.from({ length: 60 }, (_, m) => (m % 3 === 0 ? failing("solanaBalance") : passing("solanaBalance")));
    const texts = await timeline(flaps);
    expect(texts).toEqual({
      0: "[Dial watchdog, for you only] Problem: Solana network not answering (solanaBalance broke).",
      2: "[Dial watchdog, for you only] Fixed: Solana network is answering again.",
      30: "[Dial watchdog, for you only] Problem: Solana network not answering (solanaBalance broke).",
      32: "[Dial watchdog, for you only] Fixed: Solana network is answering again.",
    });
  });

  it("closes a reopened incident it never alerted about without an all-clear", async () => {
    await timeline([failing("d1"), passing("d1"), passing("d1"), failing("d1"), passing("d1")]);
    expect(await run([passing("d1")], at(5))).toBeNull();
    const [row] = await db.select().from(watchdogProblems);
    expect(row).toMatchObject({ resolvedAt: at(5), lastAlertedAt: at(0) });
  });

  it("waits for the threshold before alerting, and a blip under it resolves silently", async () => {
    expect(await run([failing("solanaBalance", 2)], at(0))).toBeNull();
    expect(await run([passing("solanaBalance")], at(1))).toBeNull();
    expect(await run([failing("solanaBalance", 2)], at(2))).toBeNull();
    expect(await run([failing("solanaBalance", 2)], at(3))).toContain("Solana network not answering");
    expect(await timeline([failing("payphoneAuth", 2), passing("payphoneAuth"), passing("payphoneAuth")])).toEqual({});
  });

  it("says 'aged out', not 'Cleared', when the bad items only left the window", async () => {
    await run([failing("unanswered")], at(0));
    await run([agedOut("unanswered")], at(60));
    expect(await run([agedOut("unanswered")], at(61))).toBe(
      "[Dial watchdog, for you only] Never fixed, now over an hour old, so no longer watched: a text got no reply.",
    );
    expect(await run([agedOut("unanswered")], at(62))).toBeNull();
  });

  it("leaves a problem untouched when its check could not run", async () => {
    await run([failing("undelivered")], at(0));
    expect(await run([{ key: "undelivered", ok: null, detail: "inbox unavailable" }], at(1))).toBeNull();
    await run([passing("undelivered")], at(2));
    expect(await run([passing("undelivered")], at(3))).toBe("[Dial watchdog, for you only] Fixed: Payphone is passing texts to the bot again.");
  });

  it("keys problems separately and puts everything for one run in one text", async () => {
    await run([failing("unanswered")], at(0));
    await run([passing("unanswered")], at(1));
    const text = await run([passing("unanswered"), failing("d1")], at(2));
    expect(text).toBe("[Dial watchdog, for you only] Problem: database unreachable (d1 broke). Fixed: every text has a reply again.");
  });

  it("retries an alert or all-clear whose text never went out", async () => {
    expect((await planAlerts(db, [failing("unanswered")], at(0))).alert).toHaveLength(1);
    // Send failed: markSent never ran.
    expect(alertText(await planAlerts(db, [failing("unanswered")], at(1)))).toContain("Problem: a text got no reply");
    await markSent(db, await planAlerts(db, [failing("unanswered")], at(2)), at(2));
    await planAlerts(db, [passing("unanswered")], at(3));
    expect((await planAlerts(db, [passing("unanswered")], at(4))).recovered).toEqual(["unanswered"]);
    expect((await planAlerts(db, [passing("unanswered")], at(5))).recovered).toEqual(["unanswered"]);
  });
});

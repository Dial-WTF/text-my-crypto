import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { watchdogProblems } from "@/lib/db/schema";
import { alertText, type CheckResult, markSent, planAlerts } from "@/lib/watchdog/problems";
import { createTestDb } from "../helpers/db";

const T0 = new Date("2026-10-09T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const failing = (key: string, alertAfter?: number): CheckResult => ({ key, ok: false, detail: `${key} broke`, alertAfter });
const passing = (key: string): CheckResult => ({ key, ok: true, detail: "ok" });

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

describe("alert dedup", () => {
  it("alerts on the first failure, then stays quiet for 30 minutes, then reminds", async () => {
    expect(await run([failing("unanswered")], at(0))).toBe("Dial watchdog. PROBLEM: unanswered: unanswered broke.");
    for (let m = 1; m < 30; m++) expect(await run([failing("unanswered")], at(m))).toBeNull();
    expect(await run([failing("unanswered")], at(30))).toContain("PROBLEM: unanswered");
  });

  it("sends one all-clear when an alerted problem clears, and nothing after", async () => {
    await run([failing("unanswered")], at(0));
    expect(await run([passing("unanswered")], at(1))).toBe("Dial watchdog. Cleared: unanswered.");
    expect(await run([passing("unanswered")], at(2))).toBeNull();
    expect(await db.select().from(watchdogProblems)).toEqual([]);
  });

  it("waits for the threshold before alerting, and a blip under it clears silently", async () => {
    expect(await run([failing("solanaBalance", 2)], at(0))).toBeNull();
    expect(await run([passing("solanaBalance")], at(1))).toBeNull();
    expect(await run([failing("solanaBalance", 2)], at(2))).toBeNull();
    expect(await run([failing("solanaBalance", 2)], at(3))).toContain("solanaBalance");
  });

  it("leaves a problem untouched when its check could not run", async () => {
    await run([failing("undelivered")], at(0));
    expect(await run([{ key: "undelivered", ok: null, detail: "inbox unavailable" }], at(1))).toBeNull();
    expect(await run([passing("undelivered")], at(2))).toBe("Dial watchdog. Cleared: undelivered.");
  });

  it("keys problems separately and puts everything for one run in one text", async () => {
    await run([failing("unanswered")], at(0));
    const text = await run([passing("unanswered"), failing("d1")], at(1));
    expect(text).toBe("Dial watchdog. PROBLEM: d1: d1 broke. Cleared: unanswered.");
  });

  it("retries an alert whose text never went out", async () => {
    const plan = await planAlerts(db, [failing("unanswered")], at(0));
    expect(plan.alert).toHaveLength(1);
    // Send failed: markSent never ran.
    expect(alertText(await planAlerts(db, [failing("unanswered")], at(1)))).toContain("unanswered");
  });
});

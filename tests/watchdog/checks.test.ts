import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { logInbound, logOutbound } from "@/lib/sms/log";
import {
  describeMissing,
  describeUnanswered,
  fetchPayphoneInbox,
  findMissing,
  findUnanswered,
  type InboxText,
} from "@/lib/watchdog/checks";
import { createTestDb } from "../helpers/db";

const ALEX = "+15550000010";
const BOB = "+15550000020";
const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
let k = 0;
const inbound = (db: Db, phone: string, body: string, at: Date) =>
  logInbound(db, { to: "+18066071387", from: phone, body, dedupeKey: `k${++k}` }, at);

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("unanswered texts", () => {
  it("flags a text over a minute old with no reply and no handled mark", async () => {
    await inbound(db, ALEX, "balance", ago(90));
    const rows = await findUnanswered(db, NOW);
    expect(rows.map((r) => r.phone)).toEqual([ALEX]);
    expect(describeUnanswered(rows, NOW)).toBe("1 text with no reply, oldest 2m (…0010)");
  });

  it("gives a text its first minute", async () => {
    await inbound(db, ALEX, "balance", ago(30));
    expect(await findUnanswered(db, NOW)).toEqual([]);
  });

  it("is satisfied by any outbound text to that phone after it", async () => {
    await inbound(db, ALEX, "balance", ago(90));
    await logOutbound(db, ALEX, "You have $1.00", ago(80));
    expect(await findUnanswered(db, NOW)).toEqual([]);
  });

  it("does not count a reply that came before the text, or a reply to someone else", async () => {
    await logOutbound(db, ALEX, "earlier reply", ago(200));
    await inbound(db, ALEX, "balance", ago(90));
    await logOutbound(db, BOB, "not for alex", ago(80));
    expect((await findUnanswered(db, NOW)).map((r) => r.phone)).toEqual([ALEX]);
  });

  it("skips texts marked handled (STOP, double-taps) and texts past the lookback", async () => {
    const id = await inbound(db, ALEX, "STOP", ago(90));
    await db.update(smsLog).set({ handledAt: ago(89) }).where(eq(smsLog.id, id ?? ""));
    await inbound(db, BOB, "hi", ago(2 * 3600));
    expect(await findUnanswered(db, NOW)).toEqual([]);
  });
});

describe("Payphone inbox", () => {
  const page = {
    success: true,
    messages: [
      { id: "a", direction: "inbound", status: "received", contact: `${ALEX}@cheogram.com`, body: " 123456 ", timestamp: "2026-10-09T11:57:00.000Z" },
      { id: "b", direction: "outbound", status: "sent", contact: ALEX, body: "Reply 123456", timestamp: "2026-10-09T11:56:30.000Z" },
      { id: "c", direction: "inbound", status: "received", contact: "nonsense", body: "x", timestamp: "2026-10-09T11:56:00.000Z" },
    ],
  };

  it("reads inbound texts, strips gateway suffixes and trims bodies", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return Response.json(page);
    }) as unknown as typeof fetch;
    const texts = await fetchPayphoneInbox({ baseUrl: "https://pp.test", apiKey: "k", line: "+18066071387" }, fetchImpl);
    expect(texts).toEqual([{ phone: ALEX, body: "123456", at: new Date("2026-10-09T11:57:00.000Z") }]);
    expect(urls[0]).toBe("https://pp.test/api/v1/sms/inbox?phone=%2B18066071387&limit=200");
  });

  it("throws on an error status or a body it does not understand", async () => {
    const cfg = { baseUrl: "https://pp.test", apiKey: "k", line: "+18066071387" };
    await expect(fetchPayphoneInbox(cfg, async () => new Response("no", { status: 502 }))).rejects.toThrow("502");
    await expect(fetchPayphoneInbox(cfg, async () => Response.json({ ok: 1 }))).rejects.toThrow("shape");
  });
});

describe("texts Payphone never delivered", () => {
  const text = (phone: string, body: string, secondsAgo: number): InboxText => ({ phone, body, at: ago(secondsAgo) });

  it("matches texts that reached sms_log a few seconds after Payphone logged them", async () => {
    await inbound(db, ALEX, "send @bob $1", ago(295));
    expect(await findMissing(db, [text(ALEX, "send @bob $1", 300)], NOW)).toEqual([]);
  });

  it("flags a text that never reached sms_log (the held-back code text)", async () => {
    await inbound(db, ALEX, "send @bob $1", ago(295));
    const missing = await findMissing(db, [text(ALEX, "send @bob $1", 300), text(ALEX, "482913", 240)], NOW);
    expect(missing.map((m) => m.body)).toEqual(["482913"]);
    expect(describeMissing(missing, NOW)).toBe("1 text in Payphone never reached Dial, oldest 4m (…0010)");
  });

  it("uses each log row once, so a repeated text that arrived once is still flagged", async () => {
    await inbound(db, ALEX, "balance", ago(295));
    const missing = await findMissing(db, [text(ALEX, "balance", 300), text(ALEX, "balance", 200)], NOW);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.at).toEqual(ago(200));
  });

  it("does not match the same body from another phone", async () => {
    await inbound(db, BOB, "balance", ago(295));
    expect(await findMissing(db, [text(ALEX, "balance", 300)], NOW)).toHaveLength(1);
  });

  it("waits two minutes before calling a text missing and ignores anything past the lookback", async () => {
    expect(await findMissing(db, [text(ALEX, "hi", 60), text(BOB, "hi", 2 * 3600)], NOW)).toEqual([]);
  });
});

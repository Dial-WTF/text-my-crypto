import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { consumeInbound, fetchProcessor, type QueuedOutcome, retryDelaySeconds } from "@/lib/sms/consumer";
import type { InboundSms } from "@/lib/sms/inbound";
import { INBOUND_LEASE_MS } from "@/lib/sms/lease";
import { claimInbound, finishInbound } from "@/lib/sms/log";
import { processInbound } from "@/lib/sms/process";
import { processQueued, receiveInbound } from "@/lib/sms/webhook";
import { createTestDb } from "../helpers/db";
import { smsSink, testDeps } from "../helpers/fakes";

const SECRET = "s".repeat(40);
const ALEX = "+15550000010";
const BOB = "+15550000020";
const forward = { phoneNumber: "+18066071387", sender: ALEX, message: "send adam $1", date: "2026-10-08T21:37:00Z" };
const post = (body: unknown) =>
  new Request("https://tmc.test/api/sms/x", { method: "POST", body: JSON.stringify(body) });
let k = 0;
const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `key${++k}` });

let logs: string[];
beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

describe("inbound webhook", () => {
  it("queues the parsed text and answers 200", async () => {
    const enqueue = vi.fn(async () => {});
    const res = await receiveInbound(post(forward), SECRET, { webhookSecret: SECRET, enqueue });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]).toEqual([
      expect.objectContaining({ from: ALEX, body: "send adam $1", dedupeKey: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
  });

  it("answers 503 when the text cannot be queued, so Payphone retries", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("Queue send failed");
    });
    const res = await receiveInbound(post(forward), SECRET, { webhookSecret: SECRET, enqueue });
    expect(res.status).toBe(503);
  });

  it("404s on a wrong secret without queueing", async () => {
    const enqueue = vi.fn(async () => {});
    const res = await receiveInbound(post(forward), "nope", { webhookSecret: SECRET, enqueue });
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("400s on junk", async () => {
    const enqueue = vi.fn(async () => {});
    const res = await receiveInbound(post({ hello: 1 }), SECRET, { webhookSecret: SECRET, enqueue });
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("logs a hashed key, never the number or the text", async () => {
    await receiveInbound(post(forward), SECRET, { webhookSecret: SECRET, enqueue: async () => {} });
    await receiveInbound(post(forward), SECRET, {
      webhookSecret: SECRET,
      enqueue: async () => {
        throw new Error(`could not queue text from ${ALEX}`);
      },
    });
    expect(logs).toHaveLength(2);
    for (const line of logs) {
      expect(line).not.toContain("5550000010");
      expect(line).not.toContain("adam");
    }
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({ evt: "sms_inbound", stage: "webhook", outcome: "enqueued" });
  });
});

describe("process route", () => {
  const queued = { to: "+18066071387", from: ALEX, body: "hi", dedupeKey: "abc" };

  it("maps outcomes to statuses the consumer understands", async () => {
    const run = async (process: () => Promise<"handled" | "duplicate" | "busy">) =>
      (await processQueued(post(queued), SECRET, { webhookSecret: SECRET, process })).status;
    expect(await run(async () => "handled")).toBe(200);
    expect(await run(async () => "duplicate")).toBe(200);
    expect(await run(async () => "busy")).toBe(409);
    expect(
      await run(async () => {
        throw new Error("boom");
      }),
    ).toBe(500);
  });

  it("404s on a wrong secret and 400s on junk", async () => {
    const process = vi.fn(async () => "handled" as const);
    expect((await processQueued(post(queued), "nope", { webhookSecret: SECRET, process })).status).toBe(404);
    expect((await processQueued(post({ x: 1 }), SECRET, { webhookSecret: SECRET, process })).status).toBe(400);
    expect(process).not.toHaveBeenCalled();
  });

  it("never takes a claim from the request body", async () => {
    const process = vi.fn(async () => "handled" as const);
    await processQueued(post({ ...queued, claim: "clm_forged" }), SECRET, { webhookSecret: SECRET, process });
    expect(process).toHaveBeenCalledWith(queued);
  });
});

describe("processInbound", () => {
  let db: Db;
  let deps: BotDeps;
  let sms: ReturnType<typeof smsSink>;
  let clock: Date;

  beforeEach(async () => {
    db = await createTestDb();
    sms = smsSink();
    clock = new Date("2026-10-09T12:00:00Z");
    deps = testDeps(db, { sendSms: sms.sendSms, now: () => clock });
  });

  it("handles a text once and skips redeliveries", async () => {
    const m = msg(BOB, "hi");
    expect(await processInbound(deps, m)).toBe("handled");
    expect(sms.to(BOB)).toHaveLength(1);
    expect(await processInbound(deps, m)).toBe("duplicate");
    expect(sms.to(BOB)).toHaveLength(1);
  });

  it("replies on redelivery when the first attempt failed after logging the text", async () => {
    const m = msg(BOB, "hi");
    sms.sendSms.mockRejectedValueOnce(new Error("Payphone send failed 502"));
    await expect(processInbound(deps, m)).rejects.toThrow(/502/);
    expect(sms.to(BOB)).toHaveLength(0);
    const [row] = await db.select().from(smsLog);
    expect(row).toMatchObject({ direction: "in", handledAt: null, claimId: null });

    expect(await processInbound(deps, m)).toBe("handled");
    expect(sms.to(BOB)).toHaveLength(1);
    expect(await processInbound(deps, m)).toBe("duplicate");
    expect(sms.to(BOB)).toHaveLength(1);
  });

  it("waits while another attempt holds the text, then takes over a stale claim", async () => {
    const m = msg(BOB, "hi");
    const first = await claimInbound(db, m, clock); // an attempt that died mid-way
    expect(first.kind).toBe("claimed");
    expect(await processInbound(deps, m)).toBe("busy");
    expect(sms.to(BOB)).toHaveLength(0);

    clock = new Date(clock.getTime() + INBOUND_LEASE_MS);
    expect(await processInbound(deps, m)).toBe("handled");
    expect(sms.to(BOB)).toHaveLength(1);
  });

  it("does not let a stale attempt mark the text handled after a takeover", async () => {
    const m = msg(BOB, "hi");
    const stale = await claimInbound(db, m, clock);
    clock = new Date(clock.getTime() + INBOUND_LEASE_MS);
    const fresh = await claimInbound(db, m, clock);
    expect(fresh.kind).toBe("claimed");
    if (stale.kind !== "claimed" || fresh.kind !== "claimed") throw new Error("expected claims");
    expect(fresh.claimId).not.toBe(stale.claimId);
    await finishInbound(db, m.dedupeKey, stale.claimId, clock);
    const [row] = await db.select().from(smsLog);
    expect(row?.handledAt).toBeNull();
    expect(await claimInbound(db, m, clock)).toEqual({ kind: "busy" });
  });
});

type FakeMessage = Message<unknown> & {
  ack: Mock<() => void>;
  retry: Mock<(options?: QueueRetryOptions) => void>;
};

function fakeMessage(body: unknown, attempts = 1): FakeMessage {
  return {
    id: `m${++k}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn<() => void>(),
    retry: vi.fn<(options?: QueueRetryOptions) => void>(),
  };
}

function fakeBatch(messages: FakeMessage[]): MessageBatch<unknown> {
  return { queue: "sms-inbound", messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: vi.fn(), retryAll: vi.fn() };
}

describe("queue consumer", () => {
  it("acks handled and duplicate texts", async () => {
    const a = fakeMessage(msg(ALEX, "hi"));
    const b = fakeMessage(msg(BOB, "hi"));
    const outcomes: Record<string, QueuedOutcome> = { [ALEX]: "handled", [BOB]: "duplicate" };
    await consumeInbound(fakeBatch([a, b]), async (m) => outcomes[m.from] ?? "failed");
    for (const m of [a, b]) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  it("retries failures with exponential backoff", async () => {
    const first = fakeMessage(msg(ALEX, "a"), 1);
    const fourth = fakeMessage(msg(BOB, "b"), 4);
    const late = fakeMessage(msg("+15550000030", "c"), 9);
    await consumeInbound(fakeBatch([first, fourth, late]), async () => "failed");
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(fourth.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(late.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(retryDelaySeconds(0)).toBe(30);
  });

  it("retries when processing throws, and retries busy texts after the lease", async () => {
    const thrown = fakeMessage(msg(ALEX, "a"));
    const busy = fakeMessage(msg(BOB, "b"));
    await consumeInbound(fakeBatch([thrown, busy]), async (m) => {
      if (m.from === ALEX) throw new Error("network down");
      return "busy";
    });
    expect(thrown.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(busy.retry).toHaveBeenCalledWith({ delaySeconds: INBOUND_LEASE_MS / 1000 });
    expect(thrown.ack).not.toHaveBeenCalled();
    expect(busy.ack).not.toHaveBeenCalled();
  });

  it("retries a malformed message toward the dead-letter queue instead of dropping it", async () => {
    const bad = fakeMessage({ nope: true });
    const process = vi.fn(async (): Promise<QueuedOutcome> => "handled");
    await consumeInbound(fakeBatch([bad]), process);
    expect(process).not.toHaveBeenCalled();
    expect(bad.retry).toHaveBeenCalled();
    expect(bad.ack).not.toHaveBeenCalled();
  });

  it("keeps one sender's texts in order", async () => {
    const seen: string[] = [];
    const texts = ["hi", "Alex", "send bob $1"].map((b) => fakeMessage(msg(ALEX, b)));
    await consumeInbound(fakeBatch(texts), async (m) => {
      await new Promise((r) => setTimeout(r, m.body === "hi" ? 5 : 0));
      seen.push(m.body);
      return "handled";
    });
    expect(seen).toEqual(["hi", "Alex", "send bob $1"]);
  });

  it("logs one line per message with outcome and attempt, never numbers or text", async () => {
    const m = fakeMessage(msg(ALEX, "send adam $1"), 3);
    await consumeInbound(fakeBatch([m]), async () => {
      throw new Error(`Payphone send failed 400: bad number ${ALEX}`);
    });
    expect(logs).toHaveLength(1);
    const line = logs[0] ?? "";
    expect(line).not.toContain("5550000010");
    expect(line).not.toContain("adam");
    expect(JSON.parse(line)).toMatchObject({ evt: "sms_inbound", stage: "consume", outcome: "failed", attempt: 3 });
  });

  it("redelivery of a handled text is acked without a second reply", async () => {
    const db = await createTestDb();
    const sms = smsSink();
    const deps = testDeps(db, { sendSms: sms.sendSms });
    const text = msg(BOB, "hi");
    const process = (m: InboundSms) => processInbound(deps, m);
    const once = fakeMessage(text, 1);
    const again = fakeMessage(text, 2);
    await consumeInbound(fakeBatch([once]), process);
    await consumeInbound(fakeBatch([again]), process);
    expect(once.ack).toHaveBeenCalled();
    expect(again.ack).toHaveBeenCalled();
    expect(sms.to(BOB)).toHaveLength(1);
  });
});

describe("fetchProcessor", () => {
  const url = new URL("https://tmc.test/api/sms/s/process");
  const respond = (status: number, body: unknown) => fetchProcessor(async () => Response.json(body, { status }), url);

  it("posts the text to the process route", async () => {
    const fetchApp = vi.fn<(req: Request) => Promise<Response>>(async () => Response.json({ outcome: "handled" }));
    const m = msg(ALEX, "hi");
    expect(await fetchProcessor(fetchApp, url)(m)).toBe("handled");
    const req = fetchApp.mock.calls[0]?.[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe(url.href);
    expect(await req?.json()).toEqual(m);
  });

  it("maps statuses to outcomes", async () => {
    const m = msg(ALEX, "hi");
    expect(await respond(200, { outcome: "duplicate" })(m)).toBe("duplicate");
    expect(await respond(409, { outcome: "busy" })(m)).toBe("busy");
    await expect(respond(500, { outcome: "failed" })(m)).rejects.toThrow(/500/);
    await expect(respond(404, {})(m)).rejects.toThrow(/404/);
    await expect(respond(200, { outcome: "weird" })(m)).rejects.toThrow(/unknown outcome/);
  });
});

import { describe, expect, it, vi } from "vitest";
import { parseInbound } from "@/lib/sms/inbound";
import { logInbound } from "@/lib/sms/log";
import { payphoneSender } from "@/lib/sms/payphone";
import { createTestDb } from "./helpers/db";

const cfg = { baseUrl: "https://pp.test", apiKey: "k", from: "+18066071387" };

describe("payphoneSender", () => {
  it("posts to /api/v1/sms/send from the bot line", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    await payphoneSender(cfg, fetchImpl)("+15550000001", "hi");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://pp.test/api/v1/sms/send");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k");
    expect(JSON.parse(String(init?.body))).toEqual({ to: "+15550000001", message: "hi", from: "+18066071387" });
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 402 }));
    await expect(payphoneSender(cfg, fetchImpl)("+1555", "x")).rejects.toThrow(/402/);
  });
});

describe("parseInbound", () => {
  it("normalizes a Payphone forward", async () => {
    const m = await parseInbound({
      phoneNumber: "+18066071387",
      sender: "(555) 000-0001",
      message: " send jeremy $10 ",
      date: "2026-10-09T12:00:00Z",
    });
    expect(m).toMatchObject({ to: "+18066071387", from: "+15550000001", body: "send jeremy $10" });
    expect(m?.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects junk", async () => {
    expect(await parseInbound({ hello: 1 })).toBeNull();
    expect(await parseInbound(null)).toBeNull();
  });
});

describe("logInbound", () => {
  it("dedupes repeated deliveries", async () => {
    const db = await createTestDb();
    const m = await parseInbound({ phoneNumber: "+18066071387", sender: "+15550000001", message: "hi", date: 1 });
    if (!m) throw new Error("parse failed");
    expect(await logInbound(db, m)).toMatch(/^sms_/);
    expect(await logInbound(db, m)).toBeNull();
  });
});

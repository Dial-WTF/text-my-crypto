import { describe, expect, it, vi } from "vitest";
import { networkName } from "@/lib/ledger";
import { cachedFor, overall, problemLabel, publicRows, roughAge, SLOW_MS, stateOf } from "@/lib/public-status";

const name = (chain: Parameters<typeof networkName>[0]) => networkName(chain, "testnet");

describe("stateOf", () => {
  it("is ok when the check passes in time, slow past the threshold, down when it fails", () => {
    expect(stateOf({ ok: true, ms: 40 })).toBe("ok");
    expect(stateOf({ ok: true, ms: SLOW_MS })).toBe("ok");
    expect(stateOf({ ok: true, ms: SLOW_MS + 1 })).toBe("slow");
    expect(stateOf({ ok: false, ms: 5 })).toBe("down");
    expect(stateOf({ ok: false, ms: SLOW_MS * 10 })).toBe("down");
  });
});

describe("publicRows", () => {
  const checks = {
    d1: { ok: true, ms: 12 },
    payphoneAuth: { ok: false, ms: 300, detail: "HTTP 401 from https://payphone.example/api?key=sk_live_secret" },
    solanaBalance: { ok: true, ms: 3_500, detail: "1000000" },
    tempoBalance: { ok: false, ms: 90, detail: "fetch failed: https://rpc.example/v2/abc123key" },
    llm: { ok: true, ms: 800, detail: 'send alex 5 "lunch"' },
    mysteryBalance: { ok: false, ms: 1 },
  };

  it("names services and networks and reports only ok/slow/down", () => {
    expect(publicRows(checks, name)).toEqual([
      { kind: "service", name: "Database", state: "ok" },
      { kind: "service", name: "Texting (Payphone)", state: "down" },
      { kind: "network", name: "Solana devnet", state: "slow" },
      { kind: "network", name: "Tempo Moderato", state: "down" },
    ]);
  });

  it("never carries detail text, timings, hosts or keys", () => {
    const out = JSON.stringify(publicRows(checks, name));
    for (const leak of ["HTTP 401", "sk_live", "rpc.example", "abc123key", "1000000", "lunch", "3500", "ms", "detail"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("leaves out checks it doesn't know, rather than showing internal names", () => {
    const names = publicRows(checks, name).map((r) => r.name);
    expect(names).not.toContain("llm");
    expect(names.some((n) => n.includes("mystery"))).toBe(false);
  });
});

describe("overall", () => {
  it("is the worst state on the board", () => {
    expect(overall([{ kind: "service", name: "Database", state: "ok" }])).toBe("ok");
    expect(
      overall([
        { kind: "service", name: "Database", state: "ok" },
        { kind: "network", name: "Solana devnet", state: "slow" },
      ]),
    ).toBe("slow");
    expect(
      overall([
        { kind: "network", name: "Solana devnet", state: "slow" },
        { kind: "network", name: "Tempo Moderato", state: "down" },
      ]),
    ).toBe("down");
  });

  it("calls an empty board down: the checks couldn't run", () => {
    expect(overall([])).toBe("down");
  });

  it("counts texting and watchdog rows, ignores plain facts, and is down without any service row", () => {
    const db = { kind: "service", name: "Database", state: "ok" } as const;
    expect(overall([db, { kind: "texting", name: "Last text answered", state: null, value: "2 min ago" }])).toBe("ok");
    expect(overall([db, { kind: "texting", name: "Texts waiting for a reply", state: "slow", value: "1" }])).toBe("slow");
    expect(overall([db, { kind: "watchdog", name: "Last watchdog run", state: "down", value: "never" }])).toBe("down");
    expect(overall([{ kind: "texting", name: "Texts waiting for a reply", state: "ok", value: "0" }])).toBe("down");
  });
});

describe("roughAge", () => {
  it("never says anything finer than a minute", () => {
    expect(roughAge(-5)).toBe("under a minute ago");
    expect(roughAge(59_999)).toBe("under a minute ago");
    expect(roughAge(60_000)).toBe("1 min ago");
    expect(roughAge(59 * 60_000 + 59_000)).toBe("59 min ago");
    expect(roughAge(60 * 60_000)).toBe("1 hour ago");
    expect(roughAge(47 * 60 * 60_000)).toBe("47 hours ago");
    expect(roughAge(72 * 60 * 60_000)).toBe("3 days ago");
  });
});

describe("problemLabel", () => {
  it("uses the watchdog's own words, capitalized", () => {
    expect(problemLabel("undelivered")).toBe("Payphone got a text but never passed it to the bot");
    expect(problemLabel("app")).toBe("The bot isn't answering at all");
    expect(problemLabel("robinhoodBalance")).toBe("Robinhood network not answering");
  });

  it("never shows a key the watchdog doesn't define", () => {
    expect(problemLabel("lastRun")).toBe("Another check is failing");
    expect(problemLabel("mysteryBalance")).toBe("Another check is failing");
    expect(problemLabel("constructor")).toBe("Another check is failing");
  });
});

describe("cachedFor", () => {
  it("reuses one result for the ttl, then loads again", async () => {
    let t = 1_000;
    const load = vi.fn(async () => t);
    const get = cachedFor(load, 60_000, () => t);
    expect(await get()).toEqual({ value: 1_000, at: 1_000, ageMs: 0 });
    t += 59_999;
    expect(await get()).toEqual({ value: 1_000, at: 1_000, ageMs: 59_999 });
    expect(load).toHaveBeenCalledTimes(1);
    t += 1;
    expect((await get()).value).toBe(61_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between everyone who asks while it runs", async () => {
    let finish: (v: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const get = cachedFor(load, 60_000, () => 0);
    const both = Promise.all([get(), get()]);
    finish("board");
    expect((await both).map((r) => r.value)).toEqual(["board", "board"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("doesn't keep a load that threw", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("d1 down")).mockResolvedValueOnce("ok");
    const get = cachedFor(load, 60_000, () => 0);
    await expect(get()).rejects.toThrow("d1 down");
    expect((await get()).value).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

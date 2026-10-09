import { describe, expect, it, vi } from "vitest";
import { networkName } from "@/lib/ledger";
import { cachedFor, overall, publicRows, SLOW_MS, stateOf } from "@/lib/public-status";

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

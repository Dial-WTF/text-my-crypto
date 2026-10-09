import { beforeEach, describe, expect, it, vi } from "vitest";
import { newReference } from "@/lib/actions/pay";
import type { ActionChainReader } from "@/lib/actions/rpc";
import type { BotDeps } from "@/lib/bot/types";
import { createUser } from "@/lib/identity";
import { REGISTRY, type SolanaNetwork } from "@/lib/settlement/registry";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, testDeps } from "../helpers/fakes";

const state: { deps?: BotDeps } = {};
const entry = REGISTRY.solana.testnet as SolanaNetwork;
const reader: ActionChainReader = {
  latestBlockhash: async () => ({ blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1EtWTRABZaYq6", lastValidBlockHeight: 1000n }),
  tokenBalance: async () => 100_000_000n,
  signatures: async () => [],
  transaction: async () => null,
};
vi.mock("@/lib/deps", () => ({ botDeps: () => state.deps }));
vi.mock("@/lib/actions/chain", () => ({ solanaActionChain: () => ({ entry, reader }) }));

const { GET, POST, OPTIONS } = await import("@/app/api/actions/pay/[handle]/route");
const actionsJson = await import("@/app/actions.json/route");

const ctx = (handle: string) => ({ params: Promise.resolve({ handle }) });
const SPEC_HEADERS = {
  "access-control-allow-origin": "*",
  "x-action-version": "2.4",
  "x-blockchain-ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};
const expectSpecHeaders = (res: Response) => {
  for (const [k, v] of Object.entries(SPEC_HEADERS)) expect(res.headers.get(k), k).toBe(v);
};

beforeEach(async () => {
  const db = await createTestDb();
  await createUser(db, { phone: "+15550000010", handle: "alex", name: null }, new Date("2026-10-09T12:00:00Z"));
  const wallet = newReference();
  state.deps = testDeps(db, { adapters: { solana: { ...fakeAdapter(), createWallet: async () => ({ address: wallet, secret: new Uint8Array(32) }) } } });
});

describe("/api/actions/pay/[handle]", () => {
  it("GET answers with the action and the spec's headers", async () => {
    const res = await GET(new Request("https://tmc.test/api/actions/pay/alex"), ctx("alex"));
    expect(res.status).toBe(200);
    expectSpecHeaders(res);
    expect(await res.json()).toMatchObject({ type: "action", title: "Pay @alex", label: "Pay" });
  });

  it("GET for an unknown handle is a spec-shaped error", async () => {
    for (const handle of ["nobody", "%E0", "@@"]) {
      const res = await GET(new Request(`https://tmc.test/api/actions/pay/${handle}`), ctx(handle));
      expect(res.status).toBe(404);
      expectSpecHeaders(res);
      expect(await res.json()).toEqual({ message: "No Dial user with that handle." });
    }
  });

  it("POST returns a transaction; bad bodies and amounts are errors with a message", async () => {
    const payer = newReference();
    const post = (url: string, body: string) => POST(new Request(url, { method: "POST", body }), ctx("alex"));

    const ok = await post("https://tmc.test/api/actions/pay/alex?amount=5", JSON.stringify({ account: payer }));
    expect(ok.status).toBe(200);
    expectSpecHeaders(ok);
    const body = (await ok.json()) as { type: string; transaction: string; message: string };
    expect(body.type).toBe("transaction");
    expect(body.transaction).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // The custom amount can also arrive as data.
    expect((await post("https://tmc.test/api/actions/pay/alex", JSON.stringify({ account: payer, data: { amount: "2.5" } }))).status).toBe(200);

    const tooBig = await post("https://tmc.test/api/actions/pay/alex?amount=51", JSON.stringify({ account: payer }));
    expect(tooBig.status).toBe(400);
    expectSpecHeaders(tooBig);
    expect(await tooBig.json()).toEqual({ message: "Amounts can be from $0.01 to $50." });

    expect((await post("https://tmc.test/api/actions/pay/alex?amount=5", "not json")).status).toBe(400);
    expect((await post("https://tmc.test/api/actions/pay/alex?amount=5", JSON.stringify({}))).status).toBe(400);
  });

  it("OPTIONS and /actions.json allow any origin", async () => {
    const pre = OPTIONS();
    expect(pre.status).toBe(200);
    expectSpecHeaders(pre);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,OPTIONS");

    const rules = actionsJson.GET();
    expect(rules.headers.get("access-control-allow-origin")).toBe("*");
    expect(await rules.json()).toEqual({
      rules: [
        { pathPattern: "/@**", apiPath: "/api/actions/pay/**" },
        { pathPattern: "/pay/*", apiPath: "/api/actions/pay/*" },
        { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
      ],
    });
    expect(actionsJson.OPTIONS().headers.get("access-control-allow-origin")).toBe("*");
  });
});

import { vi } from "vitest";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import type { LlmInterpreter } from "@/lib/operator/brain";
import { EscrowClosedError, type EscrowLookup, type EscrowProgram, type SettlementAdapter } from "@/lib/settlement/types";

type SettleCall = { to: string; amount: bigint; memo: string; closeSource: boolean };
type EscrowCall =
  | { op: "create"; intentId: string; amount: bigint; expiresAt: Date }
  | { op: "claim"; intentId: string; to: string }
  | { op: "refund"; intentId: string };
export type FakeAdapter = SettlementAdapter & { settled: SettleCall[]; funded: string[]; balances: Map<string, bigint> };

/**
 * An escrow program that records what the app asked of it and what the chain would say (`chain`, for
 * `lookup`). `fail.next` makes the next call throw; with `fail.landed` the call still takes effect on
 * the "chain" first, like a send that timed out after it landed.
 */
export type FakeEscrow = EscrowProgram & {
  calls: EscrowCall[];
  fail: { next: Error | null; landed?: boolean };
  chain: Map<string, EscrowLookup>;
};

export function fakeEscrow(programId = "Escrow1111111111111111111111111111111111111"): FakeEscrow {
  const calls: EscrowCall[] = [];
  const fail: FakeEscrow["fail"] = { next: null };
  const chain = new Map<string, EscrowLookup>();
  const done = (call: EscrowCall) => {
    const sig = `sig_${call.op}_${call.intentId}`;
    const result = { txHash: sig, explorerUrl: `https://explorer.test/${sig}` };
    const apply = () => {
      if (call.op === "create") {
        chain.set(call.intentId, { state: "open", sender: "sender", amount: call.amount, expiresAt: call.expiresAt, funded: result });
      } else {
        chain.set(call.intentId, { state: call.op === "claim" ? "claimed" : "refunded", result });
      }
    };
    if (fail.next) {
      const e = fail.next;
      if (fail.landed) apply();
      fail.next = null;
      fail.landed = false;
      throw e;
    }
    calls.push(call);
    apply();
    return result;
  };
  const closed = (intentId: string, want: "claimed" | "refunded") => {
    const now = chain.get(intentId);
    if (now?.state === want) return now.result;
    if (now?.state === "claimed" || now?.state === "refunded") throw new EscrowClosedError(now.state, now.result);
    return null;
  };
  return {
    programId,
    calls,
    fail,
    chain,
    vaultAddress: async (intentId) => `vault_${intentId}`,
    create: async ({ intentId, amount, expiresAt }) => done({ op: "create", intentId, amount, expiresAt }),
    // Like the real adapter: an escrow that already closed the same way returns that transaction,
    // the other way throws EscrowClosedError.
    claim: async ({ intentId, to }) => closed(intentId, "claimed") ?? done({ op: "claim", intentId, to }),
    refund: async ({ intentId }) => closed(intentId, "refunded") ?? done({ op: "refund", intentId }),
    lookup: async (intentId) => chain.get(intentId) ?? { state: "none" },
  };
}

export function fakeAdapter(
  opts: { defaultBalance?: bigint; chain?: SettlementAdapter["chain"]; escrow?: EscrowProgram } = {},
): FakeAdapter {
  const chain = opts.chain ?? "solana";
  let n = 0;
  const settled: SettleCall[] = [];
  const funded: string[] = [];
  const balances = new Map<string, bigint>();
  return {
    chain,
    tokenId: "Mint111",
    isValidAddress: (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) || /^0x[0-9a-fA-F]{40}$/.test(a),
    settled,
    funded,
    balances,
    createWallet: async () => ({ address: `${chain}Addr${++n}`, secret: new Uint8Array(32) }),
    getBalance: async (a) => balances.get(a) ?? opts.defaultBalance ?? 0n,
    settle: async ({ to, amount, memo, closeSource }) => {
      settled.push({ to, amount, memo, closeSource: closeSource ?? false });
      return { txHash: `sig_${memo}_${settled.length}`, explorerUrl: `https://explorer.test/sig_${memo}` };
    },
    treasuryAddress: async () => `${chain}Treasury`,
    fund: async (to, amount) => {
      funded.push(`${to}:${amount}`);
      return { txHash: "sig_fund", explorerUrl: "https://explorer.test/sig_fund" };
    },
    ...(opts.escrow ? { escrow: opts.escrow } : {}),
  };
}

const silentLlm: LlmInterpreter = vi.fn(async () => ({
  intent: "chat" as const,
  counterparty: null,
  amountUsd: null,
  chain: null,
  note: null,
  reply: 'hi, I\'m the Dial operator. Try "send jeremy $10".',
}));

export function smsSink() {
  const sent: Array<[string, string]> = [];
  const sendSms = vi.fn(async (to: string, body: string) => {
    sent.push([to, body]);
  });
  const to = (phone: string) => sent.filter(([p]) => p === phone).map(([, b]) => b);
  const last = (phone: string) => to(phone).at(-1) ?? "";
  return { sent, sendSms, to, last };
}

export function testDeps(db: Db, overrides: Partial<BotDeps> = {}): BotDeps {
  return {
    db,
    sendSms: vi.fn(async () => {}),
    llm: silentLlm,
    adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) },
    appUrl: "https://tmc.test",
    operatorNumber: "+18066071387",
    now: () => new Date("2026-10-09T12:00:00Z"),
    walletKey: Buffer.alloc(32, 9).toString("base64"),
    perTxCap: 50_000_000n,
    perDayCap: 200_000_000n,
    passkeyThreshold: 20_000_000n,
    escrowTtlDays: 7,
    dripAmount: 25_000_000n,
    network: "testnet",
    ...overrides,
  };
}

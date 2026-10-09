import { vi } from "vitest";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import type { LlmInterpreter } from "@/lib/operator/brain";
import type { EscrowProgram, SettlementAdapter } from "@/lib/settlement/types";

export type SettleCall = { to: string; amount: bigint; memo: string; closeSource: boolean };
export type EscrowCall =
  | { op: "create"; intentId: string; amount: bigint; expiresAt: Date }
  | { op: "claim"; intentId: string; to: string }
  | { op: "refund"; intentId: string };
export type FakeEscrow = EscrowProgram & { calls: EscrowCall[]; fail: { next: Error | null } };
export type FakeAdapter = SettlementAdapter & { settled: SettleCall[]; funded: string[]; balances: Map<string, bigint> };

/** An escrow program that records what the app asked of it. `fail.next` makes the next call throw. */
export function fakeEscrow(programId = "Escrow1111111111111111111111111111111111111"): FakeEscrow {
  const calls: EscrowCall[] = [];
  const fail: { next: Error | null } = { next: null };
  const done = (call: EscrowCall) => {
    if (fail.next) {
      const e = fail.next;
      fail.next = null;
      throw e;
    }
    calls.push(call);
    const sig = `sig_${call.op}_${call.intentId}`;
    return { txHash: sig, explorerUrl: `https://explorer.test/${sig}` };
  };
  return {
    programId,
    calls,
    fail,
    vaultAddress: async (intentId) => `vault_${intentId}`,
    create: async ({ intentId, amount, expiresAt }) => done({ op: "create", intentId, amount, expiresAt }),
    claim: async ({ intentId, to }) => done({ op: "claim", intentId, to }),
    refund: async ({ intentId }) => done({ op: "refund", intentId }),
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

export const silentLlm: LlmInterpreter = vi.fn(async () => ({
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

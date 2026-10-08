import { vi } from "vitest";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import type { LlmInterpreter } from "@/lib/operator/brain";
import type { SettlementAdapter } from "@/lib/settlement/types";

export type SettleCall = { to: string; amount: bigint; memo: string; closeSource: boolean };
export type FakeAdapter = SettlementAdapter & { settled: SettleCall[]; funded: string[]; balances: Map<string, bigint> };

export function fakeAdapter(opts: { defaultBalance?: bigint; chain?: SettlementAdapter["chain"] } = {}): FakeAdapter {
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
    fund: async (to, amount) => {
      funded.push(`${to}:${amount}`);
      return { txHash: "sig_fund", explorerUrl: "https://explorer.test/sig_fund" };
    },
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
    ...overrides,
  };
}

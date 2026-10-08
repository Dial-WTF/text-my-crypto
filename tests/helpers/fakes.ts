import { vi } from "vitest";
import type { LlmInterpreter } from "@/lib/operator/brain";
import type { SettlementAdapter } from "@/lib/settlement/types";

export type FakeAdapter = SettlementAdapter & { settled: string[]; funded: string[] };

export function fakeAdapter(balances: Record<string, bigint> = {}, chain: SettlementAdapter["chain"] = "solana"): FakeAdapter {
  let n = 0;
  const settled: string[] = [];
  const funded: string[] = [];
  return {
    chain,
    tokenId: "Mint111",
    settled,
    funded,
    createWallet: async () => ({ address: `${chain}Addr${++n}`, secret: new Uint8Array(32) }),
    getBalance: async (a) => balances[a] ?? 0n,
    settle: async ({ to, amount, memo }) => {
      settled.push(`${to}:${amount}:${memo}`);
      return { txHash: `sig_${memo}`, explorerUrl: `https://explorer.test/sig_${memo}` };
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
  return { sent, sendSms, to: (phone: string) => sent.filter(([p]) => p === phone).map(([, b]) => b) };
}

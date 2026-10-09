import { type ChainState, type ChainStatus, listWords } from "@/lib/chain-status";
import { type Chain, chainLabel } from "@/lib/chains";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import type { Network } from "@/lib/settlement/registry";
import type { LogoId } from "@/ui/brand/logoPaths";
import type { ChainStripItem } from "@/ui/patterns/ChainStrip/ChainStrip";
import type { Limit } from "@/ui/patterns/Limits/Limits";
import type { TranscriptLine } from "@/ui/patterns/Transcript/Transcript";

export const transcript: TranscriptLine[] = [
  { from: "you", text: "hi" },
  { from: "operator", text: "hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?" },
  { from: "you", text: "Alex" },
  { from: "operator", text: 'You\'re in, Alex. Your Dial name is @alex, so people can text me "send @alex $5".' },
  { from: "you", text: "send jeremy $10 for pizza" },
  { from: "operator", text: "What's jeremy's number?" },
  { from: "you", text: "(806) 555 0142" },
  { from: "operator", text: "Send $10 USDC to jeremy (pizza) on Solana? Reply 482913 to confirm." },
  { from: "you", text: "482913" },
  { from: "operator", text: "Sent $10 to jeremy. They have 7 days to claim it." },
];

/** What each chain does for the operator. Its status comes from chainStatuses, never from this copy. */
const CHAIN_COPY: Record<Chain, { name: string; logo: LogoId; role: string }> = {
  solana: { name: "Solana", logo: "solana", role: "USDC settlement, memo per payment, on-chain escrow for people not on Dial yet" },
  tempo: { name: "Tempo", logo: "tempo", role: "Stablecoin payments with a memo; operator pays the fees" },
  base: { name: "Base", logo: "base", role: "USDC by signed authorization; operator pays the gas" },
  ethereum: { name: "Ethereum", logo: "ethereum", role: "USDC on L1 by signed authorization; operator pays the gas" },
  arbitrum: { name: "Arbitrum", logo: "arbitrum", role: "USDC on Arbitrum, same signed-authorization flow" },
  hyperevm: { name: "Hyperliquid", logo: "hyperliquid", role: "USDC on HyperEVM, same signed-authorization flow" },
  robinhood: { name: "Robinhood Chain", logo: "robinhood", role: "Same EVM flow, in a test dollar until there is test USDC on it" },
  zcash: { name: "Zcash", logo: "zcash", role: "Shielded sends, payment id in the encrypted memo" },
};

const STATE_ORDER: Record<ChainState, number> = { live: 0, wired: 1, building: 2 };

/** One tile per chain with a prize track in the Crypto World's Fair, live chains first. */
export function settlesOn(statuses: ChainStatus[]): ChainStripItem[] {
  return [...statuses]
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state])
    .map((s) => ({ ...CHAIN_COPY[s.chain], status: s.state === "live" ? "live" : "next", statusLabel: s.label }));
}

/** Which chains settle, which are wired but off, which are being built: the colophon's chain line. */
export function chainsSentence(statuses: ChainStatus[], network: Network): string {
  const named = (state: ChainState, name: (s: ChainStatus) => string) => statuses.filter((s) => s.state === state).map(name);
  const live = named("live", (s) => s.network);
  const wired = named("wired", (s) => chainLabel(s.chain));
  const building = named("building", (s) => chainLabel(s.chain));
  const verb = (n: string[]) => (n.length === 1 ? "is" : "are");
  return [
    live.length
      ? `Payments settle in ${network === "testnet" ? "test stablecoins" : "stablecoins"} on ${listWords(live)}.`
      : "No chain is switched on right now.",
    wired.length ? `${listWords(wired)} ${verb(wired)} wired but switched off.` : "",
    building.length ? `${listWords(building)} ${verb(building)} still being built.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export type LimitSettings = {
  perPaymentUsd: string;
  perDayUsd: string;
  passkeyAboveUsd: string;
  signupDripUsd: string;
  escrowDays: number;
};

/** "$50" from "50", the way the operator's own texts write it. */
const usd = (v: string) => formatUsd(usdToBaseUnits(v));

/** The landing page's limits, from the same settings the operator enforces. The test drop only exists on testnet. */
export function limitItems(l: LimitSettings, network: Network): Limit[] {
  const drip = network === "testnet" && usdToBaseUnits(l.signupDripUsd) > 0n;
  return [
    { value: usd(l.perPaymentUsd), label: "most in one payment" },
    { value: usd(l.perDayUsd), label: "most you can send in a day" },
    { value: `Over ${usd(l.passkeyAboveUsd)}`, label: "your passkey approves it, once you add one" },
    ...(drip ? [{ value: usd(l.signupDripUsd), label: "test USDC in your wallet when you sign up" }] : []),
    { value: `${l.escrowDays} days`, label: "for someone new to claim your payment; after that, text “reclaim”" },
  ];
}

export const runsOn: ChainStripItem[] = [
  { name: "Cloudflare", logo: "cloudflare", role: "Workers + D1 run the operator", status: "live", statusLabel: "Live" },
  { name: "Payphone", logo: "payphone", role: "The phone line: +1 806 607 1387", status: "live", statusLabel: "Live" },
];

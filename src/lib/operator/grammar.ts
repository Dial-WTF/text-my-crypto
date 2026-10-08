import { type Chain, parseChain } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";

export type MoneyKind = "send" | "request" | "invoice";

export type MoneyCommand = {
  kind: MoneyKind;
  counterparty: string;
  amountUsd: string;
  note?: string;
  chain?: Chain;
};

export type WithdrawCommand = { kind: "withdraw"; amountUsd: string | "all"; address: string; chain?: Chain };

export type Command =
  | MoneyCommand
  | WithdrawCommand
  | { kind: "balance" }
  | { kind: "receive" }
  | { kind: "reclaim" }
  | { kind: "upgrade" }
  | { kind: "decline" }
  | { kind: "help" }
  | { kind: "chat" };

const WHO = String.raw`@?[a-z][a-z0-9_]{1,19}|\+?[\d\s().-]{10,}?`;
const AMT = String.raw`\$?(\d{1,7}(?:\.\d+)?)\s*(?:usdc?|dollars?|bucks)?`;
const FOR = String.raw`(?:\s+for\s+(.+?))?`;
const ON = String.raw`(?:\s+on\s+([a-z]+))?`;
const END = String.raw`\s*[.!]?$`;

type Pattern = { kind: MoneyKind; re: RegExp; who: number; amt: number; note: number; on: number };

const p = (kind: MoneyKind, src: string, who: number, amt: number, note: number, on: number): Pattern => ({
  kind,
  re: new RegExp(`^${src}${FOR}${ON}${END}`, "i"),
  who,
  amt,
  note,
  on,
});

const SEND = String.raw`(?:please\s+)?(?:send|pay|give|transfer)`;
const REQUEST = String.raw`(?:please\s+)?(?:request|ask|charge)`;
const INVOICE = String.raw`(?:invoice|bill)`;

const PATTERNS: Pattern[] = [
  p("send", String.raw`${SEND}\s+(?:to\s+)?(${WHO})\s+${AMT}`, 1, 2, 3, 4),
  p("send", String.raw`${SEND}\s+${AMT}\s+to\s+(${WHO})`, 2, 1, 3, 4),
  p("request", String.raw`${REQUEST}\s+${AMT}\s+from\s+(${WHO})`, 2, 1, 3, 4),
  p("request", String.raw`${REQUEST}\s+(${WHO})\s+for\s+${AMT}`, 1, 2, 3, 4),
  p("request", String.raw`${REQUEST}\s+(${WHO})\s+${AMT}`, 1, 2, 3, 4),
  p("invoice", String.raw`${INVOICE}\s+(${WHO})\s+${AMT}`, 1, 2, 3, 4),
];

const ADDRESS = String.raw`(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|(?:t1|t3|tm|u1|zs)[0-9a-zA-Z]{20,})`;
const WITHDRAW = new RegExp(
  String.raw`^(?:withdraw|cash out|send|move)\s+(all|everything|\$?\d{1,7}(?:\.\d+)?)\s*(?:usdc?|dollars?|bucks)?\s+to\s+${ADDRESS}${ON}${END}`,
  "i",
);

const BALANCE = /^(?:balance|bal|how much do i have)\??$/i;
const RECEIVE = /^(?:receive|my address|address|deposit|wallet)\??$/i;
const HELP = /^(?:help|\?|commands)$/i;
const RECLAIM = /^(?:reclaim|refund)$/i;
const UPGRADE = /^(?:upgrade|passkey)$/i;
const DECLINE = /^(?:no|nope|decline)$/i;

/** Phone numbers pass through untouched; names are lowercased and keep a leading "@" (which means a global Dial handle). */
export function normalizeCounterparty(raw: string): string {
  const t = raw.trim();
  return /^\+?[\d\s().-]+$/.test(t) ? t : t.toLowerCase();
}

function build(pat: Pattern, m: RegExpExecArray): Command | null {
  const who = m[pat.who];
  const amount = m[pat.amt];
  if (!who || !amount) return null;
  if (!isUsdAmount(amount)) return { kind: "chat" };
  const cmd: MoneyCommand = { kind: pat.kind, counterparty: normalizeCounterparty(who), amountUsd: amount };
  const note = m[pat.note]?.trim();
  if (note) cmd.note = note.slice(0, 120);
  const chainWord = m[pat.on];
  if (chainWord === undefined) return cmd;
  const chain = parseChain(chainWord);
  return chain ? { ...cmd, chain } : { kind: "chat" };
}

export function parseCommand(text: string): Command {
  const t = text.trim().replace(/\s+/g, " ");
  if (BALANCE.test(t)) return { kind: "balance" };
  if (RECEIVE.test(t)) return { kind: "receive" };
  if (HELP.test(t)) return { kind: "help" };
  if (RECLAIM.test(t)) return { kind: "reclaim" };
  if (UPGRADE.test(t)) return { kind: "upgrade" };
  if (DECLINE.test(t)) return { kind: "decline" };
  const w = WITHDRAW.exec(t);
  if (w?.[1] && w[2]) {
    const rawAmount = w[1].replace(/^\$/, "");
    const all = /^(all|everything)$/i.test(rawAmount);
    if (!all && !isUsdAmount(rawAmount)) return { kind: "chat" };
    const cmd: WithdrawCommand = { kind: "withdraw", amountUsd: all ? "all" : rawAmount, address: w[2] };
    if (w[3] === undefined) return cmd;
    const chain = parseChain(w[3]);
    return chain ? { ...cmd, chain } : { kind: "chat" };
  }
  for (const pat of PATTERNS) {
    const m = pat.re.exec(t);
    if (!m) continue;
    const cmd = build(pat, m);
    if (cmd) return cmd;
  }
  return { kind: "chat" };
}

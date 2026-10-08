import { type Chain, parseChain } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";

export type Command =
  | { kind: "send"; recipient: string; amountUsd: string; chain?: Chain }
  | { kind: "balance" }
  | { kind: "help" }
  | { kind: "chat" };

const VERB = String.raw`(?:please\s+)?(?:send|pay|give|transfer)`;
const WHO = String.raw`@?[a-z][a-z0-9_]{1,19}|\+?[\d\s().-]{10,}?`;
const AMT = String.raw`\$?(\d{1,7}(?:\.\d+)?)\s*(?:usdc?|dollars?|bucks)?`;
const ON = String.raw`(?:\s+on\s+([a-z]+))?`;
const END = String.raw`\s*[.!]?$`;

const RECIPIENT_FIRST = new RegExp(String.raw`^${VERB}\s+(?:to\s+)?(${WHO})\s+${AMT}${ON}${END}`, "i");
const AMOUNT_FIRST = new RegExp(String.raw`^${VERB}\s+${AMT}\s+to\s+(${WHO})${ON}${END}`, "i");
const BALANCE = /^(?:balance|bal|how much do i have)\??$/i;
const HELP = /^(?:help|\?|commands)$/i;

export function normalizeRecipient(raw: string): string {
  const t = raw.trim();
  return /^\+?[\d\s().-]+$/.test(t) ? t : t.replace(/^@/, "").toLowerCase();
}

function build(recipient: string, amount: string, chainWord: string | undefined): Command {
  if (!isUsdAmount(amount)) return { kind: "chat" };
  const cmd: Command = { kind: "send", recipient: normalizeRecipient(recipient), amountUsd: amount };
  if (chainWord === undefined) return cmd;
  const chain = parseChain(chainWord);
  return chain ? { ...cmd, chain } : { kind: "chat" };
}

export function parseCommand(text: string): Command {
  const t = text.trim().replace(/\s+/g, " ");
  if (BALANCE.test(t)) return { kind: "balance" };
  if (HELP.test(t)) return { kind: "help" };
  const a = RECIPIENT_FIRST.exec(t);
  if (a?.[1] && a[2]) return build(a[1], a[2], a[3]);
  const b = AMOUNT_FIRST.exec(t);
  if (b?.[1] && b[2]) return build(b[2], b[1], b[3]);
  return { kind: "chat" };
}

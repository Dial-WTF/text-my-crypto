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

/** `address` is an address or an ENS name / Basename; a name is resolved once, when the payment is created. */
export type WithdrawCommand = { kind: "withdraw"; amountUsd: string | "all"; address: string; chain?: Chain };

/** USDC from HyperEVM into a HyperCore spot balance: someone's, or with no counterparty, the sender's own. */
/** `venue` is the word they used ("hyperliquid", "hypercore", "hl"); the bot matches it to a chain's venue module. */
export type VenueCommand = { kind: "venue"; venue: string; amountUsd: string; counterparty?: string };

export type Command =
  | MoneyCommand
  | WithdrawCommand
  | VenueCommand
  | { kind: "venue_balance"; venue: string }
  | { kind: "price"; coin: string }
  | { kind: "balance" }
  | { kind: "receive" }
  | { kind: "reclaim" }
  | { kind: "upgrade" }
  | { kind: "decline" }
  | { kind: "directory"; query: string }
  | { kind: "rename"; name: string }
  | { kind: "whoami" }
  | { kind: "connect_agent"; label?: string }
  | { kind: "revoke_agents" }
  | { kind: "wallet" }
  | { kind: "help" }
  | { kind: "chat" };

// A handle, up to three plain words ("my guy", "my brother jake"), or a phone number. Lazy, so a trailing
// "for pizza" or "on tempo" is never swallowed into the name.
const WHO = String.raw`@?[a-z][a-z0-9_']{1,19}(?:\s[a-z][a-z0-9_']{0,19}){0,2}?|\+?[\d\s().-]{10,}?`;
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

// An EVM, Solana or Zcash address, or an ENS name / Basename ("vitalik.eth", "jesse.base.eth").
const ADDRESS = String.raw`(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|(?:t1|t3|tm|u1|zs)[0-9a-zA-Z]{20,}|(?:[a-z0-9_-]+\.)+eth)`;
const WITHDRAW = new RegExp(
  String.raw`^(?:withdraw|cash out|send|move)\s+(all|everything|\$?\d{1,7}(?:\.\d+)?)\s*(?:usdc?|dollars?|bucks)?\s+to\s+${ADDRESS}${ON}${END}`,
  "i",
);

// "to hyperliquid" means HyperCore; "on hyperliquid" stays a HyperEVM send (the chain alias).
// Words for a trading venue: Hyperliquid's (the chain alias), HyperCore (the venue's name) and "hl".
const VENUE_WORD = String.raw`hyperliquid|hypercore|hl`;
const HL = String.raw`(?<venue>${VENUE_WORD})(?:\s+(?:spot|account|balance))?`;
const HL_SELF = new RegExp(
  String.raw`^(?:move|send|transfer|deposit|bridge|put)\s+${AMT}\s+(?<prep>to|into|onto)\s+(?:my\s+)?${HL}${END}`,
  "i",
);
const TO_HL = String.raw`(?<prep>to|into|on)\s+(?:their\s+)?${HL}`;
const HL_SEND = [
  new RegExp(String.raw`^${SEND}\s+(?:to\s+)?(${WHO})\s+${AMT}\s+${TO_HL}${END}`, "i"),
  new RegExp(String.raw`^${SEND}\s+${AMT}\s+to\s+(${WHO})\s+${TO_HL}${END}`, "i"),
];
const HL_BALANCE = new RegExp(
  String.raw`^(?:(?<a>${VENUE_WORD})\s+(?:balance|bal)|(?:balance|bal)\s+(?:on\s+)?(?<b>${VENUE_WORD}))\??$`,
  "i",
);
const PRICE = /^(?:price|px|quote)\s+(?:of\s+|for\s+)?\$?([a-z][a-z0-9]{0,9})\??$|^\$?([a-z][a-z0-9]{0,9})\s+price\??$/i;

const BALANCE = /^(?:balance|bal|how much do i have)\??$/i;
const RECEIVE = /^(?:receive|my address|address|deposit|pay link|my pay link)\??$/i;
const WALLET = /^(?:wallet|my wallet|open wallet|log ?in|sign ?in)\??$/i;
const HELP = /^(?:help|\?|commands)$/i;
const RECLAIM = /^(?:reclaim|refund)$/i;
const UPGRADE = /^(?:upgrade|passkey)$/i;
const DECLINE = /^(?:no|nope|decline)$/i;
const DIRECTORY = /^(?:411|directory|lookup|look up|find|who is|whos|who's)\s+(.{2,40}?)\??$/i;
const RENAME = /^(?:call me|my name is|rename me to|rename to|rename)\s+(.{1,80})$/i;
const WHOAMI = /^(?:whoami|who am i|me)\??$/i;
const CONNECT_AGENT = /^connect\s+(?:an?\s+|my\s+)?agent(?:\s+(?:called\s+|named\s+)?(.+?))?\s*[.!]?$/i;
const REVOKE_AGENTS = /^(?:revoke|disconnect|remove)\s+(?:all\s+|my\s+)?agents?\s*[.!]?$/i;

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

/** "move $5 to hyperliquid", "send @alex $5 to hyperliquid". Checked before plain sends, which would read "hyperliquid" as a name. */
function parseVenue(t: string): Command | null {
  const self = HL_SELF.exec(t);
  const selfVenue = self?.groups?.venue;
  if (self?.[1] && selfVenue) {
    return isUsdAmount(self[1]) ? { kind: "venue", venue: selfVenue.toLowerCase(), amountUsd: self[1] } : { kind: "chat" };
  }
  for (const [i, re] of HL_SEND.entries()) {
    const m = re.exec(t);
    const [who, amount] = i === 0 ? [m?.[1], m?.[2]] : [m?.[2], m?.[1]];
    const venue = m?.groups?.venue?.toLowerCase();
    if (!who || !amount || !venue) continue;
    // "on hyperliquid" names the chain (a HyperEVM send); only "on hypercore" names the venue.
    if (m?.groups?.prep?.toLowerCase() === "on" && venue !== "hypercore") return null;
    if (!isUsdAmount(amount)) return { kind: "chat" };
    return { kind: "venue", venue, amountUsd: amount, counterparty: normalizeCounterparty(who) };
  }
  return null;
}

export function parseCommand(text: string): Command {
  const t = text.trim().replace(/\s+/g, " ");
  if (BALANCE.test(t)) return { kind: "balance" };
  const venueBalance = HL_BALANCE.exec(t);
  const balanceWord = venueBalance?.groups?.a ?? venueBalance?.groups?.b;
  if (balanceWord) return { kind: "venue_balance", venue: balanceWord.toLowerCase() };
  const price = PRICE.exec(t);
  if (price) return { kind: "price", coin: (price[1] ?? price[2] ?? "").toUpperCase() };
  const hl = parseVenue(t);
  if (hl) return hl;
  if (RECEIVE.test(t)) return { kind: "receive" };
  if (WALLET.test(t)) return { kind: "wallet" };
  if (HELP.test(t)) return { kind: "help" };
  if (RECLAIM.test(t)) return { kind: "reclaim" };
  if (UPGRADE.test(t)) return { kind: "upgrade" };
  if (DECLINE.test(t)) return { kind: "decline" };
  if (WHOAMI.test(t)) return { kind: "whoami" };
  const dir = DIRECTORY.exec(t);
  if (dir?.[1]) return { kind: "directory", query: dir[1].trim() };
  const rename = RENAME.exec(t);
  if (rename?.[1]) return { kind: "rename", name: rename[1].trim() };
  if (REVOKE_AGENTS.test(t)) return { kind: "revoke_agents" };
  const agent = CONNECT_AGENT.exec(t);
  if (agent) return agent[1] ? { kind: "connect_agent", label: agent[1] } : { kind: "connect_agent" };
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

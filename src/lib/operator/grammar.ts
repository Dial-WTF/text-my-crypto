import { type Chain, parseChain } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";

export type MoneyKind = "send" | "request" | "invoice";

export type MoneyCommand = {
  kind: MoneyKind;
  counterparty: string;
  amountUsd: string;
  note?: string;
  chain?: Chain;
  /** "send … privately": a shielded Zcash send, whatever the sender's default chain. Sends only. */
  private?: true;
};

/** `address` is an address or an ENS name / Basename; a name is resolved once, when the payment is created. */
export type WithdrawCommand = { kind: "withdraw"; amountUsd: string | "all"; address: string; chain?: Chain };

/**
 * "split $30 between @a @b @c": $30 divided among the people listed. "split $30 with @a @b" (or listing "me")
 * divides it among them and the sender, who pays everyone else's share.
 */
export type SplitCommand = {
  kind: "split";
  amountUsd: string;
  people: string[];
  includeMe: boolean;
  note?: string;
  chain?: Chain;
};

export type Command =
  | MoneyCommand
  | WithdrawCommand
  | SplitCommand
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

const SPLIT = new RegExp(String.raw`^split\s+${AMT}\s+(between|among|amongst|with)\s+(.+?)${FOR}${ON}${END}`, "i");
// One person in a list: an @handle, a phone number (digit groups may be spaced), or a plain word.
const PERSON_TOKEN = /@[a-z0-9_]+|\+?\(?\d[\d().-]*(?:\s+\(?\d[\d().-]*)*|[a-z][a-z0-9_']*/gi;
const ME = /^(?:me|myself)$/i;
const NAME = /^[a-z][a-z0-9_']*(?:\s[a-z][a-z0-9_']*){0,2}$/i;

/**
 * The people in a split list. Commas, "and" and "&" separate people, so a name can have spaces
 * ("alex, my brother jake"); without them every handle, number and word is its own person
 * ("@a @b carol"). "me" puts the sender in. Repeats are dropped. Null when something isn't a person.
 */
export function parsePeople(list: string): { people: string[]; includeMe: boolean } | null {
  const chunks = list
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const separated = chunks.length > 1;
  const people: string[] = [];
  let includeMe = false;
  for (const chunk of chunks) {
    const tokens = chunk.match(PERSON_TOKEN) ?? [];
    if (tokens.join(" ").replace(/\s+/g, "") !== chunk.replace(/\s+/g, "")) return null;
    const singles = tokens.every((t) => t.startsWith("@") || /\d/.test(t) || ME.test(t));
    const names = !separated || singles || tokens.length === 1 ? tokens : NAME.test(chunk) ? [chunk] : null;
    if (!names) return null;
    for (const name of names) {
      if (ME.test(name)) includeMe = true;
      else people.push(normalizeCounterparty(name));
    }
  }
  return { people: [...new Set(people)], includeMe };
}

function parseSplit(m: RegExpExecArray): Command {
  const [, amount, word, list, note, chainWord] = m;
  if (!amount || !word || !list) return { kind: "chat" };
  if (!isUsdAmount(amount)) return { kind: "chat" };
  const parsed = parsePeople(list);
  if (!parsed || parsed.people.length === 0) return { kind: "chat" };
  const cmd: SplitCommand = {
    kind: "split",
    amountUsd: amount,
    people: parsed.people,
    includeMe: parsed.includeMe || word.toLowerCase() === "with",
  };
  if (note?.trim()) cmd.note = note.trim().slice(0, 120);
  if (chainWord === undefined) return cmd;
  const chain = parseChain(chainWord);
  return chain ? { ...cmd, chain } : { kind: "chat" };
}

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

// "privately send …", "send privately …", "send … privately" and "send … private" (before any "for …" or
// "on …", or at the end). "for private lessons" stays a note.
const PRIVATE_LEAD = /^privately\s+/i;
const PRIVATE_AFTER_VERB = /^((?:please\s+)?(?:send|pay|give|transfer))\s+privately\s+/i;
const PRIVATE_TAIL = /\s+(?:privately|private)(?=\s+for\s|\s+on\s|\s*[.!]?$)/i;

/** The text without its "privately", or null when it doesn't ask for a private send. */
function withoutPrivately(t: string): string | null {
  const s = t.replace(PRIVATE_LEAD, "").replace(PRIVATE_AFTER_VERB, "$1 ").replace(PRIVATE_TAIL, "");
  return s === t ? null : s;
}

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
  const split = SPLIT.exec(t);
  if (split) return parseSplit(split);
  const plain = withoutPrivately(t);
  if (plain !== null) {
    const cmd = matchMoney(plain);
    // Only sends can be private; anything else asked "privately" goes to the plain-English reader.
    return cmd.kind === "send" ? { ...cmd, private: true } : { kind: "chat" };
  }
  return matchMoney(t);
}

function matchMoney(t: string): Command {
  for (const pat of PATTERNS) {
    const m = pat.re.exec(t);
    if (!m) continue;
    const cmd = build(pat, m);
    if (cmd) return cmd;
  }
  return { kind: "chat" };
}

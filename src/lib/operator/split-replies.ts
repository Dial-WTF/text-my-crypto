/**
 * What the operator texts about splits. Kept apart from replies.ts so the split feature reads in one place;
 * the generic lines (sending, failed, caps) still come from replies.ts.
 */

const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");
const approveWith = (code: string | null, link: string) =>
  code ? `Reply ${code} to confirm. Details: ${link}` : `Approve with your passkey: ${link}`;

/** One share per person, short: "$10 each to @a, @b" when they're equal, else "@a $10.01, @b $10". */
export function shareList(shares: Array<{ name: string; amount: string }>): string {
  const [first] = shares;
  if (first && shares.every((s) => s.amount === first.amount)) {
    return shares.length === 1 ? `${first.amount} to ${first.name}` : `${first.amount} each to ${shares.map((s) => s.name).join(", ")}`;
  }
  return shares.map((s) => `${s.name} ${s.amount}`).join(", ");
}

const waitingText = (waiting: string[], days: number) =>
  waiting.length ? ` ${waiting.join(", ")} ${waiting.length === 1 ? "has" : "have"} ${days} days to claim.` : "";

export const splitReplies = {
  /** `named` is the chain they asked for; `batches` a chain that can carry a split, `word` what to type for it. */
  needsBatch: (named: string, batches: string, word: string) =>
    `Splits settle in one transaction on ${batches}, so they run there, not on ${named}. Add "on ${word}" to the end and text it again.`,
  unavailable: () => `Splits aren't switched on yet. Send each person a payment instead.`,
  tooFew: () => `A split needs at least two people. Try "split $30 between @alex @sam", or "split $30 with @alex" to include you.`,
  tooMany: (max: number) => `Splits can have up to ${max} people, you included. Try fewer.`,
  tooSmall: (amount: string, ways: number) => `${amount} can't be split ${ways} ways to the cent. Try a bigger amount.`,
  unknown: (name: string) => `I don't know who "${name}" is. Use their @handle or number in the split.`,
  ambiguous: (name: string, options: string[]) => `"${name}" could be ${options.join(" or ")}. Use their @handle in the split.`,
  twice: (name: string) => `${name} is in the split twice. List each person once.`,
  /** `mine` is the sender's own share when they're in the split. */
  confirm: (
    total: string,
    ways: number,
    shares: string,
    mine: string | null,
    chain: string,
    note: string | null,
    code: string | null,
    link: string,
  ) =>
    `Split ${total}${forNote(note)} ${ways} ways on ${chain}: ${shares}${mine ? `, and ${mine} is your share` : ""}. ${approveWith(code, link)}`,
  /** `waiting` names people not on Dial yet, who have `days` to claim their share. */
  sent: (shares: string, chain: string, explorerUrl: string, waiting: string[], days: number) =>
    `Split sent on ${chain} in one transaction: ${shares}.${waitingText(waiting, days)} Receipt: ${explorerUrl}`,
  /**
   * The transaction landed but the chain held some shares back (a receive or transfer policy): `held` lists
   * them, `shares` what did arrive (null for none).
   */
  partlySent: (shares: string | null, held: string, chain: string, explorerUrl: string, waiting: string[], days: number) =>
    (shares ? `Split sent on ${chain} in one transaction: ${shares}.${waitingText(waiting, days)}` : `None of your split arrived.`) +
    ` ${chain} held back ${held}: the receiving wallet doesn't accept the transfer, so the network is holding that money and it's marked not sent.` +
    ` Receipt: ${explorerUrl}`,
  unconfirmed: (total: string) =>
    `Your ${total} split is taking longer than usual to confirm. I'll text you as soon as it does, so don't send it again.`,
  statusWaitingOnYou: (total: string, shares: string, code: string | null, link: string) =>
    code
      ? `Still waiting on you: your ${total} split, ${shares}. New code: reply ${code} to confirm, or "nevermind" to cancel.`
      : `Still waiting on you: your ${total} split, ${shares}. Approve with your passkey: ${link}`,
  sending: (total: string, ways: number, chain: string) => `Sending your ${total} split to ${ways} people on ${chain}…`,
  statusSending: (total: string) => `Sending your ${total} split now. I'll text you the receipt.`,
  statusSent: (shares: string, url: string | null) => `Yes, your split went through: ${shares}.${url ? ` Receipt: ${url}` : ""}`,
} as const;

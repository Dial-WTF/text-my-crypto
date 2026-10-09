/**
 * What the operator texts about splits. Kept apart from replies.ts so the split feature reads in one place;
 * the generic lines (sending, failed, caps) still come from replies.ts.
 */

const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");
const approveWith = (code: string | null, link: string) =>
  code ? `Reply ${code} to confirm, or tap: ${link}` : `Approve with your passkey: ${link}`;

/** One share per person, short: "$10 each to @a, @b" when they're equal, else "@a $10.01, @b $10". */
export function shareList(shares: Array<{ name: string; amount: string }>): string {
  const [first] = shares;
  if (first && shares.every((s) => s.amount === first.amount)) {
    return shares.length === 1 ? `${first.amount} to ${first.name}` : `${first.amount} each to ${shares.map((s) => s.name).join(", ")}`;
  }
  return shares.map((s) => `${s.name} ${s.amount}`).join(", ");
}

export const splitReplies = {
  tempoOnly: (chain: string) =>
    `Splits settle in one transaction on Tempo, so they run there, not on ${chain}. Add "on tempo" to the end and text it again.`,
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
    note: string | null,
    code: string | null,
    link: string,
  ) =>
    `Split ${total}${forNote(note)} ${ways} ways on Tempo: ${shares}${mine ? `, and ${mine} is your share` : ""}. ${approveWith(code, link)}`,
  /** `waiting` names people not on Dial yet, who have `days` to claim their share. */
  sent: (shares: string, explorerUrl: string, waiting: string[], days: number) =>
    `Split sent on Tempo in one transaction: ${shares}.` +
    (waiting.length ? ` ${waiting.join(", ")} ${waiting.length === 1 ? "has" : "have"} ${days} days to claim.` : "") +
    ` Receipt: ${explorerUrl}`,
  statusWaitingOnYou: (total: string, shares: string, code: string | null, link: string) =>
    code
      ? `Still waiting on you: your ${total} split, ${shares}. New code: reply ${code} to confirm, or "nevermind" to cancel.`
      : `Still waiting on you: your ${total} split, ${shares}. Approve with your passkey: ${link}`,
  sending: (total: string, ways: number) => `Sending your ${total} split to ${ways} people on Tempo…`,
  statusSending: (total: string) => `Sending your ${total} split now. I'll text you the receipt.`,
  statusSent: (shares: string, url: string | null) => `Yes, your split went through: ${shares}.${url ? ` Receipt: ${url}` : ""}`,
} as const;

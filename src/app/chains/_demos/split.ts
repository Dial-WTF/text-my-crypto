/** The split preview's maths, kept pure so it is tested and runs in the browser without the network. */

export const MIN_LEGS = 2;
export const MAX_PREVIEW_LEGS = 5;

export type SplitLeg = { to: string; cents: number };

export type SplitPreview = { ok: true; legs: SplitLeg[] } | { ok: false; error: string };

/** "@alex, sam  +15550100000" → ["@alex", "@sam", "+15550100000"]: handles get an "@", numbers stay as typed. */
export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => (/^\+?\d{7,15}$/.test(w) || w.startsWith("@") ? w : `@${w}`));
}

/**
 * Splits a dollar amount evenly into cents, the leftover cents going to the first legs, so the legs always
 * add up to exactly the amount. `maxLegs` is the most one transaction carries on the chain.
 */
export function splitPreview(amountUsd: string, recipients: string[], maxLegs: number): SplitPreview {
  const limit = Math.min(MAX_PREVIEW_LEGS, maxLegs);
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(amountUsd.trim().replace(/^\$/, ""))) {
    return { ok: false, error: 'Type a dollar amount like "10" or "12.50".' };
  }
  const total = Math.round(Number(amountUsd.trim().replace(/^\$/, "")) * 100);
  const unique = [...new Set(recipients.map((r) => r.toLowerCase()))];
  if (unique.length < MIN_LEGS || unique.length > limit) {
    return { ok: false, error: `Name ${MIN_LEGS} to ${limit} different people.` };
  }
  if (total < unique.length) return { ok: false, error: "Each person needs at least a cent." };
  const share = Math.floor(total / unique.length);
  const extra = total - share * unique.length;
  return { ok: true, legs: unique.map((to, i) => ({ to, cents: share + (i < extra ? 1 : 0) })) };
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

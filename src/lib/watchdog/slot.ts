// No imports: worker.ts bundles this outside the Next.js app.

const SLOT_MS = 30 * 60_000;
const CRON_MS = 60_000;

let lastSlot = -1;

/**
 * Throttle for alerts that cannot reach D1 to remember when they last went out. Memory is no good:
 * cron runs often land on fresh isolates. Instead, only the run in the first minute of each 30-minute
 * slot (:00 and :30) may send, and this isolate never sends twice in one slot. With a cron every
 * minute that is at most one stateless alert per 30 minutes, at the cost of up to 30 minutes' delay.
 */
export function mayAlertStateless(nowMs: number): boolean {
  if (nowMs % SLOT_MS >= CRON_MS) return false;
  const slot = Math.floor(nowMs / SLOT_MS);
  if (slot === lastSlot) return false;
  lastSlot = slot;
  return true;
}

/** Tests only. */
export function resetSlotForTests(): void {
  lastSlot = -1;
}

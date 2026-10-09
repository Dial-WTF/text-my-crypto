import type { Intent } from "@/lib/db/schema";

const LABEL: Record<Intent["status"], string> = {
  pending: "awaiting approval",
  settling: "sending",
  escrowed: "waiting to be claimed",
  settled: "delivered",
  refunded: "refunded",
  failed: "failed",
  declined: "cancelled",
};

/** What a payment's state means to a person. A pending payment past its deadline is expired: nothing moved. */
export function stateLabel(status: Intent["status"], expiresAt: Date | null, now: Date): string {
  if (status === "pending" && expiresAt && expiresAt <= now) return "expired";
  return LABEL[status];
}

/** "just now", "5m ago", "2h ago", "3d ago", then a date. Short enough for a receipt line. */
export function timeAgo(at: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

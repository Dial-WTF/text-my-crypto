/**
 * One structured log line per inbound-SMS event. Carries a short prefix of the dedupe key (a hash),
 * never phone numbers or message text.
 */
export type InboundTrace = {
  stage: "webhook" | "process" | "consume";
  key: string;
  outcome: string;
  attempt?: number;
  error?: string;
};

export function traceInbound(t: InboundTrace): void {
  const line = JSON.stringify({ evt: "sms_inbound", ...t, key: t.key.slice(0, 12) });
  if (t.error) console.error(line);
  else console.log(line);
}

/** An error's name and message with anything number-like masked, safe to log. */
export function describeError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.replace(/\+?\d[\d\s().-]{5,}\d/g, "[n]").slice(0, 200);
}

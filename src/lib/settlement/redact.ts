/**
 * Error text from RPC clients quotes the full URL, and keyed RPCs carry their key in it. Keep only
 * the host so a message can be logged, stored on a payment or shown in the health check.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/([^/\s?#"']+)[^\s"']*/g, (_m, host: string) => `${host}/…`);
}

/** The error's message, safe to log or store. */
export function errorText(e: unknown): string {
  return redactUrls(e instanceof Error ? e.message : String(e));
}

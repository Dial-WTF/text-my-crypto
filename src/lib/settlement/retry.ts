const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const RATE_LIMITED = /\b429\b|too many requests/i;

/**
 * A 429 from either client. viem says so in the message. @solana/kit puts the status in `context.statusCode`, and in a
 * production build (NODE_ENV=production) its message is only an encoded error number, so the message alone misses it.
 */
function isRateLimited(e: unknown): boolean {
  if (!(e instanceof Error)) return RATE_LIMITED.test(String(e));
  const context = (e as { context?: unknown }).context;
  const status = typeof context === "object" && context !== null ? (context as { statusCode?: unknown }).statusCode : undefined;
  return status === 429 || RATE_LIMITED.test(e.message);
}

/** Retries an RPC call when the node rate-limits us (HTTP 429), with exponential backoff. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 6, baseMs = 500): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || i >= attempts - 1) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
}

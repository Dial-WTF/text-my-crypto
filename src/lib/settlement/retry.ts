const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRateLimited(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String((e as { context?: unknown }).context ?? "")}` : String(e);
  return /\b429\b|too many requests/i.test(text);
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

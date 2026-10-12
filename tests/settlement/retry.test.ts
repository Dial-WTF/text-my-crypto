import { describe, expect, it, vi } from "vitest";
import { withRateLimitRetry } from "@/lib/settlement/retry";

describe("withRateLimitRetry", () => {
  it("retries 429s and returns the eventual result", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("HTTP error (429): Too Many Requests"))
      .mockResolvedValueOnce("ok");
    expect(await withRateLimitRetry(fn, 3, 1)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a @solana/kit HTTP 429 whose production message is only an error number", async () => {
    // What SolanaError looks like under NODE_ENV=production: the status is only in `context`.
    const prodError = Object.assign(new Error("Solana error #8100002; Decode this error by running `npx @solana/errors decode -- 8100002 'eyJ...'`"), {
      context: { statusCode: 429, headers: {} },
    });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(prodError).mockResolvedValueOnce("ok");
    expect(await withRateLimitRetry(fn, 3, 1)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown non-Error that says 429", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce("429 Too Many Requests").mockResolvedValueOnce("ok");
    expect(await withRateLimitRetry(fn, 3, 1)).toBe("ok");
  });

  it("does not retry other HTTP errors carried in context", async () => {
    const e = Object.assign(new Error("Solana error #8100002"), { context: { statusCode: 500 } });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(e);
    await expect(withRateLimitRetry(fn, 3, 1)).rejects.toBe(e);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry other errors", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("blockhash not found"));
    await expect(withRateLimitRetry(fn, 3, 1)).rejects.toThrow("blockhash");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("429"));
    await expect(withRateLimitRetry(fn, 3, 1)).rejects.toThrow("429");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

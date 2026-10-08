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

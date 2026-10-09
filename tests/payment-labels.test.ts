import { describe, expect, it } from "vitest";
import { stateLabel, timeAgo } from "@/lib/payment-labels";

const now = new Date("2026-10-09T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("stateLabel", () => {
  it("calls a pending payment past its deadline expired, and one still open awaiting approval", () => {
    expect(stateLabel("pending", ago(1), now)).toBe("expired");
    expect(stateLabel("pending", new Date(now.getTime() + 60_000), now)).toBe("awaiting approval");
  });

  it("ignores the deadline once a payment moved or ended", () => {
    expect(stateLabel("settled", ago(60_000), now)).toBe("delivered");
    expect(stateLabel("escrowed", ago(60_000), now)).toBe("waiting to be claimed");
    expect(stateLabel("declined", null, now)).toBe("cancelled");
  });
});

describe("timeAgo", () => {
  it("rounds down to the largest unit", () => {
    expect(timeAgo(ago(20_000), now)).toBe("just now");
    expect(timeAgo(ago(5 * 60_000 + 59_000), now)).toBe("5m ago");
    expect(timeAgo(ago(2 * 3_600_000), now)).toBe("2h ago");
    expect(timeAgo(ago(3 * 86_400_000), now)).toBe("3d ago");
    expect(timeAgo(ago(40 * 86_400_000), now)).toBe("Aug 30, 2026");
  });

  it("treats a clock skewed into the future as just now", () => {
    expect(timeAgo(new Date(now.getTime() + 5000), now)).toBe("just now");
  });
});

import { describe, expect, it } from "vitest";
import { canTransition, INTENT_TRANSITIONS, type IntentStatus, TERMINAL } from "@/lib/bot/machine/intent-lifecycle";

describe("PaymentIntent lifecycle", () => {
  it("reaches every status from pending", () => {
    const seen = new Set<IntentStatus>(["pending"]);
    const queue: IntentStatus[] = ["pending"];
    while (queue.length) {
      const from = queue.shift() as IntentStatus;
      for (const to of Object.keys(INTENT_TRANSITIONS[from]) as IntentStatus[]) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(INTENT_TRANSITIONS).sort());
  });

  it("has terminal states that never move again", () => {
    expect(TERMINAL.sort()).toEqual(["declined", "failed", "refunded", "settled"]);
  });

  it("allows only the documented moves", () => {
    expect(canTransition("pending", "settling")).toBe(true);
    expect(canTransition("escrowed", "settling")).toBe(true);
    expect(canTransition("settled", "pending")).toBe(false);
    expect(canTransition("pending", "settled")).toBe(false);
    expect(canTransition("declined", "settling")).toBe(false);
  });
});

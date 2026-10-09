import { describe, expect, it } from "vitest";
import { actionErrorMessage, amountProblem, fillHref, parseActionGet, transactionFrom } from "@/lib/actions/blink";

const GET = { type: "action", title: "Pay @alex", description: "USDC on Solana", icon: "https://tmc.test/i.png", label: "Pay" };

describe("fillHref", () => {
  it("fills known placeholders URL-encoded and leaves unknown ones as they are", () => {
    expect(fillHref("/api/actions/pay/alex?amount={amount}&note={note}", { amount: "2.50 " })).toBe(
      "/api/actions/pay/alex?amount=2.50%20&note={note}",
    );
  });
});

describe("amountProblem", () => {
  it("with no maximum, asks for at least the minimum (a cent by default)", () => {
    expect(amountProblem("abc", {})).toBe("Enter an amount in dollars of at least $0.01, like 5 or 2.50.");
    expect(amountProblem("0", {})).toBe("Amounts can be of at least $0.01.");
    expect(amountProblem("$1000000", {})).toBeNull();
  });

  it("with a range, refuses below the minimum, above the maximum and sub-cent precision", () => {
    const param = { min: 1, max: 50 };
    expect(amountProblem("0.99", param)).toBe("Amounts can be from $1 to $50.");
    expect(amountProblem("50.01", param)).toBe("Amounts can be from $1 to $50.");
    expect(amountProblem("5.001", param)).toBe("Enter an amount in dollars from $1 to $50, like 5 or 2.50.");
    expect(amountProblem(" $50 ", param)).toBeNull();
  });
});

describe("parseActionGet", () => {
  it("refuses anything that isn't an action with a title, description, icon and label", () => {
    expect(parseActionGet(null)).toBeNull();
    expect(parseActionGet("action")).toBeNull();
    expect(parseActionGet({ ...GET, type: "completed" })).toBeNull();
    expect(parseActionGet({ ...GET, icon: 7 })).toBeNull();
  });

  it("keeps only well-formed links, and no links when there is no list", () => {
    expect(parseActionGet(GET)?.links?.actions).toEqual([]);
    expect(parseActionGet({ ...GET, links: { actions: "nope" } })?.links?.actions).toEqual([]);
    const ok = { type: "transaction", href: "/api/actions/pay/alex?amount=5", label: "$5" };
    expect(parseActionGet({ ...GET, links: { actions: [ok, null, "x", { href: 1, label: "$1" }, { href: "/a" }] } })?.links?.actions).toEqual([ok]);
  });

  it("carries disabled only when it is true, and an error only when it has a message", () => {
    expect(parseActionGet({ ...GET, disabled: "yes" })).not.toHaveProperty("disabled");
    expect(parseActionGet({ ...GET, disabled: true })?.disabled).toBe(true);
    expect(parseActionGet({ ...GET, error: { message: 4 } })).not.toHaveProperty("error");
    expect(parseActionGet({ ...GET, error: null })).not.toHaveProperty("error");
    expect(parseActionGet({ ...GET, error: { message: "Paused" } })?.error).toEqual({ message: "Paused" });
  });
});

describe("actionErrorMessage", () => {
  it("is the message only when there is a non-blank one", () => {
    expect(actionErrorMessage(null)).toBeNull();
    expect(actionErrorMessage("Bad")).toBeNull();
    expect(actionErrorMessage({ message: "  " })).toBeNull();
    expect(actionErrorMessage({ message: 3 })).toBeNull();
    expect(actionErrorMessage({ message: "Over the cap" })).toBe("Over the cap");
  });
});

describe("transactionFrom", () => {
  it("takes a non-empty transaction from a transaction (or untyped) response, and nothing else", () => {
    expect(transactionFrom(null)).toBeNull();
    expect(transactionFrom({ type: "post", transaction: "AQID" })).toBeNull();
    expect(transactionFrom({ transaction: "" })).toBeNull();
    expect(transactionFrom({ transaction: 5 })).toBeNull();
    expect(transactionFrom({ transaction: "AQID", message: 1 })).toEqual({ transaction: "AQID", message: null });
    expect(transactionFrom({ type: "transaction", transaction: "AQID", message: "Pays $5" })).toEqual({ transaction: "AQID", message: "Pays $5" });
  });
});

import { describe, expect, it } from "vitest";
import {
  actionErrorMessage,
  amountProblem,
  base64ToBytes,
  bytesToBase64,
  fillHref,
  ownActionPath,
  parseActionGet,
  transactionFrom,
} from "@/lib/actions/blink";
import { payActionMetadata } from "@/lib/actions/pay";
import { payActionUrl } from "@/lib/pay-links";

const PAGE = "https://tmc.test/@alex/blink";
const ORIGINS = ["https://tmc.test", "https://app.tmc.test"];

describe("Blink checkout: which actions it will load", () => {
  it("accepts this site's own pay action and returns a path on the page's origin", () => {
    expect(ownActionPath("/api/actions/pay/alex?amount=5", PAGE, ORIGINS)).toBe("/api/actions/pay/alex?amount=5");
    expect(ownActionPath("https://tmc.test/api/actions/pay/alex", PAGE, ORIGINS)).toBe("/api/actions/pay/alex");
    // The configured app URL counts too (a dev or preview page whose links name production), but the
    // request still goes to the page's own origin: only the path comes back.
    expect(ownActionPath("https://app.tmc.test/api/actions/pay/alex?note=pizza", PAGE, ORIGINS)).toBe("/api/actions/pay/alex?note=pizza");
  });

  it("refuses other origins, other paths and other schemes", () => {
    for (const href of [
      "https://evil.test/api/actions/pay/alex",
      "//evil.test/api/actions/pay/alex",
      "https://tmc.test.evil.test/api/actions/pay/alex",
      "http://tmc.test/api/actions/pay/alex",
      "https://user:pw@tmc.test/api/actions/pay/alex",
      "https://tmc.test/api/wallet/send",
      "https://tmc.test/api/actions/../wallet/send",
      "/api/actions/%2e%2e/wallet/send",
      "/@alex",
      "javascript:alert(1)",
      "solana-action:https://tmc.test/api/actions/pay/alex",
      "data:application/json,{}",
      "http://[::1",
    ]) {
      expect(ownActionPath(href, PAGE, ORIGINS), href).toBeNull();
    }
  });

  it("accepts every link the pay action's GET hands out, with the custom amount filled in", () => {
    const deps = { appUrl: "https://tmc.test", perTxCap: 50_000_000n, network: "testnet" as const };
    const body = payActionMetadata(deps, "solana", { handle: "alex", name: "Alex Rivera" }, { note: "pizza" });
    const links = body.links?.actions ?? [];
    expect(links.map((l) => l.label)).toEqual(["$1", "$5", "$10", "Pay"]);
    const paths = links.map((l) => ownActionPath(fillHref(l.href, { amount: "2.50" }), PAGE, ORIGINS));
    expect(paths).toEqual([
      "/api/actions/pay/alex?amount=1&note=pizza",
      "/api/actions/pay/alex?amount=5&note=pizza",
      "/api/actions/pay/alex?amount=10&note=pizza",
      "/api/actions/pay/alex?amount=2.50&note=pizza",
    ]);
    // The page itself asks for a path built from the handle, never a URL from its query string.
    expect(ownActionPath(payActionUrl("", "alex", { amountUsd: "5" }), PAGE, ORIGINS)).toBe("/api/actions/pay/alex?amount=5");
  });

  it("encodes what is filled into a placeholder, so it can't add query parameters", () => {
    expect(fillHref("/api/actions/pay/alex?amount={amount}", { amount: "1&note=x" })).toBe("/api/actions/pay/alex?amount=1%26note%3Dx");
    expect(fillHref("/api/actions/pay/alex?amount={amount}", {})).toBe("/api/actions/pay/alex?amount={amount}");
  });
});

describe("Blink checkout: amounts and responses", () => {
  const param = { min: 0.01, max: 50 };

  it("respects the action's min and max and allows cents", () => {
    expect(amountProblem("5", param)).toBeNull();
    expect(amountProblem("$2.50", param)).toBeNull();
    expect(amountProblem("0.01", param)).toBeNull();
    expect(amountProblem("50", param)).toBeNull();
    expect(amountProblem("50.01", param)).toBe("Amounts can be from $0.01 to $50.");
    expect(amountProblem("0", param)).toBe("Amounts can be from $0.01 to $50.");
    expect(amountProblem("1.234", param)).toMatch(/^Enter an amount in dollars from \$0.01 to \$50/);
    expect(amountProblem("five", param)).toMatch(/^Enter an amount/);
    expect(amountProblem("", param)).toMatch(/^Enter an amount/);
  });

  it("reads a GET body and refuses anything that isn't an action", () => {
    const deps = { appUrl: "https://tmc.test", perTxCap: 50_000_000n, network: "testnet" as const };
    const body = payActionMetadata(deps, "solana", { handle: "alex", name: null }, {});
    expect(parseActionGet(JSON.parse(JSON.stringify(body)))).toEqual(body);
    expect(parseActionGet({ type: "completed", title: "x" })).toBeNull();
    expect(parseActionGet(null)).toBeNull();
    expect(parseActionGet({ ...body, links: { actions: [{ label: "no href" }] } })?.links?.actions).toEqual([]);
  });

  it("reads an ActionError's message and a POST's transaction", () => {
    expect(actionErrorMessage({ message: "No Dial user with that handle." })).toBe("No Dial user with that handle.");
    expect(actionErrorMessage({ message: "" })).toBeNull();
    expect(actionErrorMessage("oops")).toBeNull();
    expect(transactionFrom({ type: "transaction", transaction: "AQID", message: "Pays $5.00" })).toEqual({ transaction: "AQID", message: "Pays $5.00" });
    expect(transactionFrom({ type: "external-link", transaction: "AQID" })).toBeNull();
    expect(transactionFrom({ type: "transaction" })).toBeNull();
  });

  it("round-trips base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64(bytes)).toBe("AAEC+v8=");
    expect(base64ToBytes("AAEC+v8=")).toEqual(bytes);
  });
});

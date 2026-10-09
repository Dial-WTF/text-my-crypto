import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classify } from "@/lib/bot/machine/classify";
import { decide, type Session } from "@/lib/bot/machine/decide";
import { isUsdAmount } from "@/lib/money";
import { normalizeCounterparty, parseCommand, parsePeople } from "@/lib/operator/grammar";

/** Words the grammar cares about, so random texts reach deep into it rather than stopping at "chat". */
const WORDS = [
  "send", "pay", "request", "invoice", "split", "withdraw", "between", "among", "with", "me", "and", "&", ",",
  "for", "on", "solana", "tempo", "base", "zcash", "all", "everything", "to", "from", "$5", "5", "5.25", "0.001",
  "9999999", "10000000", "$", "@alex", "@a_b", "alex", "my guy", "+15550000001", "(555) 000-0002", "555.000.0003",
  "0x0000000000000000000000000000000000000001", "411", "call me", "rename", "balance", "help", "stop", "cancel",
  "yes", "new", "1", "123456", "usdc", "bucks", ".", "!", "?", "  ", "\n", "🙏", "é", "‮", "​",
];
const commandish = fc.array(fc.constantFrom(...WORDS), { maxLength: 14 }).map((w) => w.join(" "));
/** Anything a phone can send: ASCII, any unicode (lone surrogates included), command-shaped word salad. */
const anyText = fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: "binary", maxLength: 300 }), commandish);

const SESSIONS: Session[] = [
  { account: "unknown", optedOut: false, convo: null, awaitingApproval: false },
  { account: "unclaimed", optedOut: false, convo: null, awaitingApproval: false },
  { account: "claimed", optedOut: false, convo: null, awaitingApproval: true },
  { account: "claimed", optedOut: true, convo: null, awaitingApproval: false },
  { account: "claimed", optedOut: false, convo: { state: "awaiting_name", payload: {} }, awaitingApproval: false },
];

describe("the grammar on arbitrary texts", () => {
  it("never throws, and any money it finds is a well-formed amount", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const cmd = parseCommand(text);
        if (cmd.kind === "send" || cmd.kind === "request" || cmd.kind === "invoice" || cmd.kind === "split") {
          expect(isUsdAmount(cmd.amountUsd)).toBe(true);
        }
        if (cmd.kind === "withdraw") expect(cmd.amountUsd === "all" || isUsdAmount(cmd.amountUsd)).toBe(true);
        if (cmd.kind === "split") expect(cmd.people.length).toBeGreaterThan(0);
        if ("note" in cmd && cmd.note !== undefined) expect(cmd.note.length).toBeLessThanOrEqual(120);
      }),
      { numRuns: 2000 },
    );
  });

  it("classifies and decides any text in any session without throwing", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom(...SESSIONS), (text, session) => {
        expect(decide(session, classify(text)).do).toEqual(expect.any(String));
      }),
      { numRuns: 1000 },
    );
  });

  it("parsePeople and normalizeCounterparty never throw", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const people = parsePeople(text);
        if (people) for (const p of people.people) expect(p.trim()).toBe(p);
        expect(typeof normalizeCounterparty(text)).toBe("string");
      }),
    );
  });

  it("answers a full-length text quickly, whatever is in it (no catastrophic regex backtracking)", () => {
    // 1,600 characters is the longest a concatenated SMS gets.
    const long = fc.oneof(
      fc.string({ minLength: 1000, maxLength: 1600 }),
      fc.stringMatching(/^[\d\s().+-]{1000,1600}$/),
      fc.array(fc.constantFrom(...WORDS), { minLength: 200, maxLength: 400 }).map((w) => w.join(" ").slice(0, 1600)),
      fc.constantFrom("send ", "split $5 between ", "pay ", "withdraw ").chain((p) =>
        fc.stringMatching(/^[a-z0-9 @,.&()+-]{1000,1600}$/).map((s) => p + s),
      ),
    );
    fc.assert(
      fc.property(long, (text) => {
        const t0 = performance.now();
        parseCommand(text);
        classify(text);
        expect(performance.now() - t0).toBeLessThan(100);
      }),
      { numRuns: 200 },
    );
  });
});

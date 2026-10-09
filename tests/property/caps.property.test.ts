import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkMoney, overDailyCap } from "@/lib/bot/money";
import { intents, type User, users } from "@/lib/db/schema";
import { isUsdAmount, usdToBaseUnits } from "@/lib/money";
import { cleanAsk } from "@/lib/views/pay";
import { createTestDb } from "../helpers/db";
import { testDeps } from "../helpers/fakes";

const PER_TX = 50_000_000n;
const PER_DAY = 200_000_000n;
const NOW = new Date("2026-10-09T12:00:00Z");
const START_OF_DAY = new Date("2026-10-09T00:00:00Z").getTime();

/** Amount-shaped text, valid or not: "5", "49.99", "50.01", "0", "1.234", "$5", " 7 ", "1e3". */
const amountText = fc.oneof(
  fc.bigInt({ min: 0n, max: 10_000n }).map((c) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`),
  fc.nat(120).map(String),
  fc.stringMatching(/^[\d.$e\s-]{0,10}$/),
  fc.string(),
);

describe("the per-payment cap", () => {
  it("checkMoney accepts exactly the well-formed amounts above zero and at most the cap", async () => {
    const deps = testDeps(await createTestDb(), { perTxCap: PER_TX });
    const user = { defaultChain: "solana" } as User;
    fc.assert(
      fc.property(amountText, (s) => {
        const r = checkMoney(deps, user, { amountUsd: s });
        const base = isUsdAmount(s) ? usdToBaseUnits(s) : 0n;
        const allowed = base > 0n && base <= PER_TX;
        expect(r.ok).toBe(allowed);
        if (r.ok) expect(r.amount).toBe(base);
        else expect(r.error.code).toBe(base > PER_TX ? "over_cap" : "bad_amount");
      }),
    );
  });

  it("a pay link only keeps an amount within the cap, and a short single-line note with no hidden characters", () => {
    fc.assert(
      fc.property(fc.option(amountText), fc.option(fc.string({ unit: "binary", maxLength: 200 })), (amount, note) => {
        const ask = cleanAsk({ perTxCap: PER_TX }, { amount, note });
        if (ask.amountUsd !== undefined) {
          const base = usdToBaseUnits(ask.amountUsd);
          expect(base).toBeGreaterThan(0n);
          expect(base).toBeLessThanOrEqual(PER_TX);
        }
        if (ask.note !== undefined) {
          expect(ask.note.length).toBeGreaterThan(0);
          expect(ask.note.length).toBeLessThanOrEqual(60);
          expect(ask.note).not.toMatch(/[\p{Cc}\p{Cf}]|\s{2,}|^\s|\s$|[\n\r\t]/u);
        }
      }),
    );
  });
});

type Past = { status: (typeof intents.$inferInsert)["status"]; cents: bigint; minutesAgo: number };

const past: fc.Arbitrary<Past> = fc.record({
  status: fc.constantFrom("pending", "settling", "escrowed", "settled", "refunded", "failed", "declined"),
  cents: fc.bigInt({ min: 1n, max: 5_000n }),
  // From yesterday morning to now: some count toward today, some don't.
  minutesAgo: fc.integer({ min: 0, max: 36 * 60 }),
});

describe("the daily cap", () => {
  it("counts what left (settling, escrowed, settled) since midnight UTC, and refuses past the cap", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(past, { maxLength: 12 }), fc.bigInt({ min: 1n, max: 5_000n }), async (history, cents) => {
        const db = await createTestDb();
        const deps = testDeps(db, { perDayCap: PER_DAY, now: () => NOW });
        await db.insert(users).values([
          { id: "u_me", phone: "+15550000001" },
          { id: "u_them", phone: "+15550000002" },
        ]);
        if (history.length) {
          await db.insert(intents).values(
            history.map((h, i) => ({
              id: `pi_${i}`,
              createdBy: "u_me",
              senderId: "u_me",
              recipientId: "u_them",
              chain: "solana" as const,
              token: "Mint111",
              recipientAddress: "addr",
              amount: h.cents * 10_000n,
              nonce: `n${i}`,
              expiresAt: NOW,
              status: h.status,
              createdAt: new Date(NOW.getTime() - h.minutesAgo * 60_000),
            })),
          );
        }
        const counted = history
          .filter((h) => ["settling", "escrowed", "settled"].includes(h.status) && NOW.getTime() - h.minutesAgo * 60_000 >= START_OF_DAY)
          .reduce((a, h) => a + h.cents * 10_000n, 0n);
        const amount = cents * 10_000n;
        const user = { id: "u_me" } as User;
        expect(await overDailyCap(deps, user, amount)).toBe(counted + amount > PER_DAY);
      }),
      { numRuns: 40 },
    );
  });
});

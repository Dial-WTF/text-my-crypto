import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import { reconcileTransfers } from "@/lib/bot/settle";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { getIntent } from "@/lib/intents";
import { HeldBackError, type TransferOutcome } from "@/lib/settlement/types";
import { TransferUnconfirmedError } from "@/lib/settlement/unconfirmed";
import { createTestDb } from "../helpers/db";
import { type FakeAdapter, fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";
const NEWBIE = "+15550000099";
const TX = "sig_went_out";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let sol: FakeAdapter;
let clock: Date;
let outcome: TransferOutcome;
let asked: Array<{ txHash: string; sentAt: Date; legs?: unknown }>;
let k = 0;

const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `u${++k}` });
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";
const intentIdIn = (s: string) => /\/a\/(pi_[\w-]+)/.exec(s)?.[1] ?? "";

/** Approves a send whose transfer goes out but never gets an answer back. Returns the payment id. */
async function sendUnanswered(to: string, amount = "$3"): Promise<string> {
  const confirm = await say(ALEX, `send ${to} ${amount}`);
  const settle = sol.settle;
  sol.settle = async () => {
    throw new TransferUnconfirmedError("solana", TX, new Error("fetch failed"));
  };
  await say(ALEX, codeIn(confirm));
  sol.settle = settle;
  return intentIdIn(confirm);
}

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  clock = new Date("2026-10-09T12:00:00Z");
  outcome = { state: "pending" };
  asked = [];
  sol = fakeAdapter({ defaultBalance: 100_000_000n });
  sol.transferOutcome = async (txHash, { sentAt }, legs) => {
    asked.push({ txHash, sentAt, ...(legs ? { legs } : {}) });
    return outcome;
  };
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: sol }, now: () => clock });
  for (const [phone, name] of [
    [ALEX, "alex"],
    [JEREMY, "jeremy"],
  ] as const) {
    await say(phone, "hi");
    await say(phone, name);
  }
});

describe("a transfer that went out without an answer", () => {
  it("is never called failed or sent again: it waits, and the sender is told not to resend", async () => {
    const id = await sendUnanswered("@jeremy");
    const intent = await getIntent(db, id);
    expect(intent?.status).toBe("settling");
    expect(sms.last(ALEX)).toBe(
      "Your $3 to @jeremy is taking longer than usual to confirm. I'll text you as soon as it does, so don't send it again.",
    );
    expect(sms.to(ALEX).join("\n")).not.toContain("No funds moved");
    expect(sol.settled).toHaveLength(0);
  });

  it("settles from the chain once the transaction lands, and both people get their receipts", async () => {
    const id = await sendUnanswered("@jeremy");
    expect(await reconcileTransfers(deps)).toEqual({ settled: 0, failed: 0 });
    const sent = (await getIntent(db, id))!;
    expect(asked).toEqual([{ txHash: TX, sentAt: sent.approvedAt!, legs: [{ to: sent.recipientAddress, amount: 3_000_000n }] }]);

    outcome = { state: "landed", result: { txHash: TX, explorerUrl: `https://explorer.test/${TX}` } };
    expect(await reconcileTransfers(deps)).toEqual({ settled: 1, failed: 0 });
    expect(await getIntent(db, id)).toMatchObject({ status: "settled", txHash: TX, error: null });
    expect(sms.last(ALEX)).toBe(`Sent $3 to jeremy on Solana. Receipt: https://explorer.test/${TX}`);
    expect(sms.last(JEREMY)).toMatch(/^jeremy, you got \$3 from alex on Solana\. Receipt: https:\/\/explorer\.test\/sig_went_out/);

    // Done once: a second run finds nothing to do and texts nobody.
    const texts = sms.sent.length;
    expect(await reconcileTransfers(deps)).toEqual({ settled: 0, failed: 0 });
    expect(sms.sent).toHaveLength(texts);
  });

  it("fails, and says so, only when the chain says it can't land", async () => {
    const id = await sendUnanswered("@jeremy");
    outcome = { state: "failed" };
    expect(await reconcileTransfers(deps)).toEqual({ settled: 0, failed: 1 });
    expect((await getIntent(db, id))?.status).toBe("failed");
    expect(sms.last(ALEX)).toBe("That payment didn't go through. No funds moved.");
  });

  it("a payment to someone new lands in its escrow wallet and they hear how to claim it", async () => {
    const id = await sendUnanswered(NEWBIE.replace("+1", ""));
    outcome = { state: "landed", result: { txHash: TX, explorerUrl: `https://explorer.test/${TX}` } };
    expect(await reconcileTransfers(deps)).toEqual({ settled: 1, failed: 0 });
    const intent = await getIntent(db, id);
    expect(intent).toMatchObject({ status: "escrowed", txHash: TX });
    expect(intent?.escrowExpiresAt?.getTime()).toBe(clock.getTime() + 7 * 86_400_000);
    expect(sms.last(NEWBIE)).toMatch(/^alex sent you \$3/);
  });

  it("landed but held back from the recipient is failed, and the sender hears where the money is", async () => {
    const id = await sendUnanswered("@jeremy");
    outcome = { state: "landed", result: { txHash: TX, explorerUrl: null }, heldBack: [0] };
    expect(await reconcileTransfers(deps)).toEqual({ settled: 0, failed: 1 });
    expect(await getIntent(db, id)).toMatchObject({ status: "failed", error: `Held back by a transfer policy in ${TX}` });
    expect(sms.last(ALEX)).toBe(
      "Your $3 to @jeremy didn't arrive. Their wallet doesn't accept the transfer, so Solana is holding the money instead. It's marked not sent.",
    );
    expect(sms.to(JEREMY).join("\n")).not.toContain("you got $3");
  });

  it("a send held back at once is failed the same way, never 'no funds moved'", async () => {
    const confirm = await say(ALEX, "send @jeremy $3");
    sol.settle = async () => {
      throw new HeldBackError({ txHash: TX, explorerUrl: null }, [0], ["0xjeremy"]);
    };
    await say(ALEX, codeIn(confirm));
    expect((await getIntent(db, intentIdIn(confirm)))?.status).toBe("failed");
    expect(sms.last(ALEX)).toMatch(/^Your \$3 to @jeremy didn't arrive\./);
  });

  it("waits for a person when the chain can't be asked", async () => {
    const id = await sendUnanswered("@jeremy");
    delete sol.transferOutcome;
    expect(await reconcileTransfers(deps)).toEqual({ settled: 0, failed: 0 });
    expect((await getIntent(db, id))?.status).toBe("settling");
  });
});

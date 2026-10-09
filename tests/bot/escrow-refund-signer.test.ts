import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import { findUserByPhone } from "@/lib/identity";
import type { InboundSms } from "@/lib/sms/inbound";
import { getWallet, unsealWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, fakeEscrow, smsSink, testDeps } from "../helpers/fakes";

// Arbitrum's dial_escrow takes a refund only on the sender's signature, so the bot hands the program
// the sender's key. Programs anyone can crank (Solana's) ignore it.
const ALEX = "+15550000010";

let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let clock: Date;
let k = 0;
const say = async (from: string, body: string) => {
  await handleInbound(deps, { to: "+18066071387", from, body, dedupeKey: `k${++k}` } satisfies InboundSms);
  return sms.last(from);
};
const codeIn = (s: string) => /\b(\d{6})\b/.exec(s)?.[1] ?? "";

describe("refunding a program escrow", () => {
  let esc: ReturnType<typeof fakeEscrow>;
  let secrets: Array<Uint8Array | undefined>;

  beforeEach(async () => {
    const db = await createTestDb();
    sms = smsSink();
    clock = new Date("2026-10-09T12:00:00Z");
    esc = fakeEscrow();
    secrets = [];
    const refund = esc.refund;
    esc.refund = async (args) => {
      secrets.push(args.senderSecret);
      return refund(args);
    };
    deps = testDeps(db, {
      sendSms: sms.sendSms,
      adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n, escrow: esc }) },
      now: () => clock,
    });
    await say(ALEX, "hi");
    await say(ALEX, "alex");
  });

  it("passes the program the sender's wallet key", async () => {
    const confirm = await say(ALEX, "send $4 to (555) 000-0099");
    await say(ALEX, codeIn(confirm));
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    expect(await say(ALEX, "reclaim")).toBe("Got back $4 from 1 unclaimed payment.");

    const alex = await findUserByPhone(deps.db, ALEX);
    const wallet = await getWallet(deps.db, alex!.id, "solana");
    expect(secrets).toEqual([await unsealWallet(wallet!, deps.walletKey)]);
  });
});

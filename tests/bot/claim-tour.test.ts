import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { parseCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000030";
const RILEY = "+15550000031";
const GSM = /^[\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/u;

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let k = 0;

const from = (phone: string) => async (body: string) => {
  await handleInbound(deps, { to: "+18066071387", from: phone, body, dedupeKey: `t${++k}` });
  return sms.last(phone);
};
const alex = from(ALEX);
const riley = from(RILEY);
const codeIn = (text: string) => /\b(\d{6})\b/.exec(text)?.[1] ?? "";

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) } });
  await alex("hi");
  await alex("Alex");
});

async function sendRiley(amount: string): Promise<void> {
  await alex(`send ${RILEY.replace("+1", "")} $${amount}`);
  await alex(codeIn(sms.last(ALEX)));
}

describe("someone's first claim", () => {
  it("is followed by their wallet, how to pay and cash out by text, the dashboard and the guide, once", async () => {
    await sendRiley("5");
    await riley("hi");
    await riley("Riley");
    const offer = sms.to(RILEY).find((m) => /Reply \d{6} to claim it\.$/.test(m)) ?? "";
    await riley(codeIn(offer));

    const [claimed, tour] = sms.to(RILEY).slice(-2);
    expect(claimed).toMatch(/^Claimed \$5 from Alex\. It's in your Dial wallet now, nothing to set up\. Receipt: /);
    expect(tour).toMatch(/^Your Dial wallet: \$[\d.]+ USDC on Solana\. Sending is just a text: SEND @friend \$1 pays a friend, WITHDRAW ALL TO <your address> moves it to your own wallet\. Text WALLET for your dashboard\. Guide: https:\/\/tmc\.test\/how-it-works#got-paid$/);
    expect(tour).toMatch(GSM);

    await sendRiley("2");
    const before = sms.to(RILEY).length;
    // Riley is on Dial now, so the second gift settles straight to them: no claim, and no second tour.
    expect(sms.to(RILEY).slice(before).some((m) => m.startsWith("Your Dial wallet"))).toBe(false);
    expect(sms.to(RILEY).filter((m) => m.startsWith("Your Dial wallet"))).toHaveLength(1);
  });
});

describe("a bare withdraw", () => {
  it("explains how to say where the money goes, in any case", async () => {
    for (const t of ["withdraw", "WITHDRAW", "cash out", "Cash out?", "how do i withdraw", "withdraw all"]) {
      expect(parseCommand(t)).toEqual({ kind: "withdraw_help" });
    }
    expect(parseCommand("withdraw all to 0x00000000000000000000000000000000000000aa on base").kind).toBe("withdraw");
    expect(await alex("Withdraw")).toBe(replies.withdrawHowTo("https://tmc.test"));
    expect(replies.withdrawHowTo("https://tmc.test")).toMatch(/how-it-works#cash-out$/);
  });
});

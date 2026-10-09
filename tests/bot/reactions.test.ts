import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import { getConversation } from "@/lib/conversations";
import type { Db } from "@/lib/db/client";
import type { InboundSms } from "@/lib/sms/inbound";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000020";

let db: Db;
let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let k = 0;

const say = async (body: string) => {
  const msg: InboundSms = { to: "+18066071387", from: ALEX, body, dedupeKey: `r${++k}` };
  await handleInbound(deps, msg);
};

beforeEach(async () => {
  db = await createTestDb();
  sms = smsSink();
  deps = testDeps(db, { sendSms: sms.sendSms, adapters: { solana: fakeAdapter({ defaultBalance: 100_000_000n }) } });
  await say("hi");
  await say("Alex");
});

describe("reactions to the operator's texts", () => {
  it("get no reply, and leave a question the operator asked open", async () => {
    await say("send $1 to Roger");
    const before = sms.to(ALEX).length;
    const asked = await getConversation(db, ALEX, deps.now());
    expect(asked?.state).toBe("awaiting_number");

    await say("Loved “amm claimed the $1 you sent.”");
    await say("Reacted 😂 to “What's roger's number?”");

    expect(sms.to(ALEX)).toHaveLength(before);
    expect(await getConversation(db, ALEX, deps.now())).toEqual(asked);
  });

  it("get no reply from someone who isn't on Dial either", async () => {
    const stranger = "+15550000021";
    await handleInbound(deps, { to: "+18066071387", from: stranger, body: "Liked “hi, I'm the Dial operator”", dedupeKey: "r-s" });
    expect(sms.to(stranger)).toHaveLength(0);
  });
});

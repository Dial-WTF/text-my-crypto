import { beforeEach, describe, expect, it } from "vitest";
import { peekAgentLink, redeemAgentLink } from "@/lib/agents/keys";
import { handleInbound } from "@/lib/bot/handle-inbound";
import type { BotDeps } from "@/lib/bot/types";
import { findUserByPhone } from "@/lib/identity";
import { parseCommand } from "@/lib/operator/grammar";
import { createTestDb } from "../helpers/db";
import { smsSink, testDeps } from "../helpers/fakes";

describe("parseCommand: agents", () => {
  it.each([
    ["connect agent", { kind: "connect_agent" }],
    ["Connect an agent", { kind: "connect_agent" }],
    ["connect my agent", { kind: "connect_agent" }],
    ["connect agent claude", { kind: "connect_agent", label: "claude" }],
    ["connect agent named My Bot.", { kind: "connect_agent", label: "My Bot" }],
    ["revoke agents", { kind: "revoke_agents" }],
    ["Revoke all agents", { kind: "revoke_agents" }],
    ["disconnect agent", { kind: "revoke_agents" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it("leaves lookalikes alone", () => {
    expect(parseCommand("connect me to an agent please")).toEqual({ kind: "chat" });
    expect(parseCommand("send agent $5")).toMatchObject({ kind: "send", counterparty: "agent" });
  });
});

describe("connect agent over SMS", () => {
  const ALEX = "+15550000010";
  let deps: BotDeps;
  let sms: ReturnType<typeof smsSink>;
  let k = 0;
  const say = async (body: string) => {
    await handleInbound(deps, { to: "+18066071387", from: ALEX, body, dedupeKey: `k${++k}` });
    return sms.last(ALEX);
  };

  beforeEach(async () => {
    sms = smsSink();
    deps = testDeps(await createTestDb(), { sendSms: sms.sendSms });
    await say("hi");
    await say("alex");
  });

  it("texts a one-time link and code to the account's own phone", async () => {
    const reply = await say("connect agent claude");
    expect(reply).toMatch(
      /^Connect an AI agent to your Dial account: open https:\/\/tmc\.test\/k\/[\w-]{32} and enter \d{6}\. The key shows once\./,
    );
    const token = /\/k\/([\w-]+)/.exec(reply)?.[1] ?? "";
    const user = await findUserByPhone(deps.db, ALEX);
    expect(await peekAgentLink(deps.db, token, deps.now())).toEqual({ userId: user?.id, label: "claude" });
  });

  it("revoke agents cuts off keys and unused links", async () => {
    const first = await say("connect agent");
    const r = await redeemAgentLink(
      deps.db,
      /\/k\/([\w-]+)/.exec(first)?.[1] ?? "",
      /enter (\d{6})/.exec(first)?.[1] ?? "",
      deps.now(),
    );
    expect(r.ok).toBe(true);
    const pending = await say("connect agent");
    expect(await say("revoke agents")).toBe('Revoked 1 agent key. Text "connect agent" to connect one again.');
    expect(await peekAgentLink(deps.db, /\/k\/([\w-]+)/.exec(pending)?.[1] ?? "", deps.now())).toBeNull();
    expect(await say("revoke agents")).toBe('No agents are connected. Text "connect agent" to connect one.');
  });

  it("needs an account first", async () => {
    const STRANGER = "+15550000077";
    await handleInbound(deps, { to: "+18066071387", from: STRANGER, body: "connect agent", dedupeKey: "s1" });
    expect(sms.last(STRANGER)).toMatch(/^hi, I'm the Dial operator/);
  });
});

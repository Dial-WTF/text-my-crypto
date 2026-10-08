import { describe, expect, it } from "vitest";
import type { Conversation } from "@/lib/conversations";
import type { Input } from "@/lib/bot/machine/classify";
import { decide, type Session } from "@/lib/bot/machine/decide";

const s = (over: Partial<Session> = {}): Session => ({
  account: "claimed",
  optedOut: false,
  convo: null,
  awaitingApproval: false,
  ...over,
});
const text = (t: string): Input => ({ kind: "text", text: t });
const awaitingName: Conversation = { state: "awaiting_name", payload: {} };
const awaitingNumber: Conversation = { state: "awaiting_number", payload: { name: "mom", command: "{}" } };
const awaitingChoice: Conversation = {
  state: "awaiting_choice",
  payload: { name: "jeremy", command: "{}", handles: ["a1", "b2"] },
};
const awaitingDuplicate: Conversation = { state: "awaiting_duplicate", payload: { command: "{}" } };

describe("decide: compliance", () => {
  it("STOP always opts out, once", () => {
    expect(decide(s(), { kind: "stop" })).toEqual({ do: "optOut" });
    expect(decide(s({ account: "unknown" }), { kind: "stop" })).toEqual({ do: "optOut" });
    expect(decide(s({ optedOut: true }), { kind: "stop" })).toEqual({ do: "silence" });
  });

  it("opted-out numbers get silence until START", () => {
    expect(decide(s({ optedOut: true }), text("send jeremy $5"))).toEqual({ do: "silence" });
    expect(decide(s({ optedOut: true }), { kind: "help" })).toEqual({ do: "silence" });
    expect(decide(s({ optedOut: true }), { kind: "start" })).toEqual({ do: "optIn" });
  });

  it("HELP and empty texts always get help", () => {
    expect(decide(s({ account: "unknown" }), { kind: "help" })).toEqual({ do: "help" });
    expect(decide(s(), { kind: "empty" })).toEqual({ do: "help" });
  });
});

describe("decide: onboarding", () => {
  it("welcomes strangers, then takes their name", () => {
    expect(decide(s({ account: "unknown" }), text("yo"))).toEqual({ do: "welcome" });
    expect(decide(s({ account: "unknown", convo: awaitingName }), text("J. P. Meyer"))).toEqual({
      do: "signup",
      name: "J. P. Meyer",
    });
  });

  it("asks for a name before any command, code or number", () => {
    const naming = s({ account: "unclaimed", convo: awaitingName });
    expect(decide(naming, text("send jeremy $5"))).toEqual({ do: "nameFirst" });
    expect(decide(naming, { kind: "code", code: "123456" })).toEqual({ do: "welcome" });
    expect(decide(naming, { kind: "phone", phone: "+15550000001" })).toEqual({ do: "badName" });
  });
});

describe("decide: answers to the operator's questions", () => {
  it("codes approve, nevermind cancels", () => {
    expect(decide(s(), { kind: "code", code: "482913" })).toEqual({ do: "approve", code: "482913" });
    expect(decide(s({ convo: awaitingChoice }), { kind: "nevermind" })).toEqual({ do: "nevermind" });
  });

  it("picks and numbers answer a pending choice", () => {
    expect(decide(s({ convo: awaitingChoice }), { kind: "pick", index: 1 })).toEqual({ do: "pick", index: 1 });
    expect(decide(s({ convo: awaitingChoice }), { kind: "phone", phone: "+15550000002" })).toEqual({
      do: "useNumber",
      phone: "+15550000002",
    });
    expect(decide(s({ convo: awaitingNumber }), { kind: "phone", phone: "+15550000002" })).toEqual({
      do: "useNumber",
      phone: "+15550000002",
    });
  });

  it("a new request drops whatever was pending", () => {
    expect(decide(s({ convo: awaitingNumber }), text("balance"))).toEqual({ do: "command", text: "balance" });
    expect(decide(s({ convo: awaitingChoice }), text("send @alex $1"))).toEqual({ do: "command", text: "send @alex $1" });
  });

  it("NEW confirms an intentional repeat; 'yes' while a code is pending explains codes", () => {
    expect(decide(s({ convo: awaitingDuplicate }), { kind: "new" })).toEqual({ do: "confirmNew" });
    expect(decide(s({ convo: awaitingDuplicate }), { kind: "affirm" })).toEqual({ do: "confirmNew" });
    expect(decide(s({ awaitingApproval: true }), { kind: "affirm" })).toEqual({ do: "codeHint" });
    expect(decide(s(), { kind: "affirm" })).toEqual({ do: "command", text: "yes" });
  });
});

describe("decide: totality", () => {
  const accounts: Session["account"][] = ["unknown", "unclaimed", "claimed"];
  const convos: Array<Conversation | null> = [null, awaitingName, awaitingNumber, awaitingChoice, awaitingDuplicate];
  const inputs: Input[] = [
    { kind: "empty" },
    { kind: "stop" },
    { kind: "start" },
    { kind: "help" },
    { kind: "nevermind" },
    { kind: "new" },
    { kind: "affirm" },
    { kind: "code", code: "123456" },
    { kind: "pick", index: 0 },
    { kind: "phone", phone: "+15550000003" },
    text("send jeremy $5"),
    text("hello there"),
  ];

  it("maps every combination to exactly one action, and never speaks to opted-out numbers except START", () => {
    let n = 0;
    for (const account of accounts)
      for (const optedOut of [false, true])
        for (const convo of convos)
          for (const awaitingApproval of [false, true])
            for (const input of inputs) {
              const a = decide({ account, optedOut, convo, awaitingApproval }, input);
              expect(a.do).toBeTruthy();
              if (optedOut) expect(["silence", "optIn"]).toContain(a.do);
              if (account !== "claimed" && !optedOut) {
                expect(["approve", "pick", "useNumber", "command", "confirmNew", "codeHint", "nevermind"]).not.toContain(a.do);
              }
              n++;
            }
    expect(n).toBe(3 * 2 * 5 * 2 * 12);
  });
});

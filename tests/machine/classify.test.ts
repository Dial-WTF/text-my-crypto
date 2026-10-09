import { describe, expect, it } from "vitest";
import { classify } from "@/lib/bot/machine/classify";

describe("classify", () => {
  it.each([
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],
    ["STOP", { kind: "stop" }],
    ["Unsubscribe", { kind: "stop" }],
    ["cancel", { kind: "stop", cancel: true }],
    ["CANCEL.", { kind: "stop", cancel: true }],
    ["quit", { kind: "stop" }],
    ["start", { kind: "start" }],
    ["HELP", { kind: "help" }],
    ["nvm", { kind: "nevermind" }],
    ["never mind.", { kind: "nevermind" }],
    ["new", { kind: "new" }],
    ["yes!", { kind: "affirm" }],
    ["👍", { kind: "affirm" }],
    ["482913", { kind: "code", code: "482913" }],
    ["482 913", { kind: "code", code: "482913" }],
    ["482-913", { kind: "code", code: "482913" }],
    ["2", { kind: "pick", index: 1 }],
    ["(806) 555-0142", { kind: "phone", phone: "+18065550142" }],
    ["+44 7700 900123", { kind: "phone", phone: "+447700900123" }],
    ["send jeremy $5", { kind: "text", text: "send jeremy $5" }],
    ["stop sending me stuff", { kind: "text", text: "stop sending me stuff" }],
    ["1234567", { kind: "text", text: "1234567" }],
    ["Ty", { kind: "thanks", text: "Ty" }],
    ["thanks!", { kind: "thanks", text: "thanks" }],
    ["did it work?", { kind: "status", text: "did it work?" }],
  ])("%j", (raw, expected) => {
    expect(classify(raw)).toEqual(expected);
  });

  it("truncates very long texts", () => {
    const r = classify("a".repeat(2000));
    expect(r.kind === "text" && r.text.length).toBe(600);
  });
});

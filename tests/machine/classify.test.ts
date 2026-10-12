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

  it("recognises reactions phones send as texts, and nothing that merely looks like one", () => {
    for (const r of [
      "Loved “amm claimed the $1 you sent.”",
      'Liked "Sent $2 to +•••••••0142. They have 7 days to claim it."',
      "Laughed at “Already heard that”",
      "Emphasized “Reply 123456 to confirm”",
      "Questioned “Send $2 USDC to alex on Solana?”",
      "Disliked “You have $0”",
      "Removed a heart from “amm claimed the $1 you sent.”",
      "Reacted 😂 to “What's roger's number?”",
      'Reacted 👍 to "Sending $2 to alex on Solana…"',
      "Removed 👍 from “Sending $2”",
      "Loved an image",
    ]) {
      expect(classify(r)).toEqual({ kind: "reaction" });
    }
    for (const t of ["loved it", "liked that, send @alex $5", "send @loved $5", "Reacted", "Loved"]) {
      expect(classify(t).kind).not.toBe("reaction");
    }
  });

  it("truncates very long texts", () => {
    const r = classify("a".repeat(2000));
    expect(r.kind === "text" && r.text.length).toBe(600);
  });
});

import { describe, expect, it } from "vitest";
import { replies, TWO_SEGMENTS } from "@/lib/operator/replies";

// The production URL is the long one; the copy has to fit with it.
const APP = "https://text-my-crypto.raspy-thunder-20d2.workers.dev";
// GSM-7 basic set plus the newline: anything else drops the whole text to 70-character UCS-2 segments.
const GSM = /^[A-Za-z0-9 \n@£$¥!"#%&'()*+,\-./:;<=>?¡¿§ÄÖÑÜäöñüàèéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ]*$/;

const required = (body: string) => {
  expect(body).toContain("Dial operator by Dial.Work");
  expect(body).toContain("Msg frequency varies.");
  expect(body).toContain("Msg & data rates may apply.");
  expect(body).toContain("Reply HELP for help, STOP to opt out.");
  expect(body).toContain(`Terms: ${APP}/terms`);
  expect(body).toMatch(/What name should people use to pay you\?$/);
  expect(body).toMatch(GSM);
};

describe("first-contact disclosures", () => {
  it("the welcome names the program, carries the carrier lines and fits in two segments", () => {
    const body = replies.welcome(APP);
    required(body);
    expect(body).toMatch(/^hi, I'm the Dial operator by Dial\.Work\. I can help you text your crypto\./);
    expect(body.length).toBeLessThanOrEqual(TWO_SEGMENTS);
  });

  it("the welcome with money waiting fits too, for an everyday name", () => {
    const body = replies.welcomeWithMoney("$25", "Jeremy Meyer", APP);
    required(body);
    expect(body).toContain("Jeremy Meyer sent you $25 USDC and it's waiting for you.");
    expect(body.length).toBeLessThanOrEqual(TWO_SEGMENTS);
  });

  it("past two segments, the disclosure leads on its own line and the question stays", () => {
    const body = replies.welcomeWithMoney("$25", "Bartholomew Alexander Fitzgerald-Montgomery", APP);
    required(body);
    const [first, second] = body.split("\n");
    expect(first).toBe(
      `Dial operator by Dial.Work: Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms: ${APP}/terms`,
    );
    expect(second).toBe("Bartholomew Alexander Fitzgerald-Montgomery sent you $25 USDC. What name should people use to pay you?");
    expect(body.length).toBeLessThanOrEqual(TWO_SEGMENTS);
  });

  it("HELP names the program, the help page and how to stop, then lists the commands", () => {
    const help = replies.help(APP);
    expect(help).toBe(
      `Dial operator by Dial.Work: send and get paid in crypto by text. Help: ${APP}/how-it-works. Msg & data rates may apply. Reply STOP to cancel.`,
    );
    const commands = replies.commands();
    for (const c of ["send", "request", "invoice", "balance", "receive", "wallet", "withdraw", "reclaim", "411", "connect agent", "status"]) {
      expect(commands.toLowerCase()).toContain(c);
    }
    expect(help).toMatch(GSM);
    expect(commands).toMatch(GSM);
    expect(commands.length).toBeLessThanOrEqual(160);
  });

  it("texts to people who never texted end with the opt-out line", () => {
    const footer = / Dial operator: msg & data rates may apply\. Reply STOP to opt out\.$/;
    expect(replies.receivedUnclaimed("$5", "alex", null, `${APP}/a/pi_x`)).toMatch(footer);
    expect(replies.payRequestNewcomer("alex", "$5", "pizza")).toMatch(footer);
    expect(replies.payInvoiceNewcomer("alex", "$5", null)).toMatch(footer);
    expect(replies.payRequestNewcomer("alex", "$5", "pizza")).not.toMatch(/\d{6}/);
  });

  it("joined ends by pointing at HELP", () => {
    expect(replies.joined("Riley", "riley", "$25")).toMatch(/ Text HELP anytime\.$/);
    expect(replies.joined("Riley", "riley", null)).toMatch(/ Text HELP anytime\.$/);
  });
});

describe("the wallet text", () => {
  it("carries the permanent link and the code, in one GSM-7 segment even for a 32-character handle", () => {
    const link = `${APP}/@${"a".repeat(32)}/wallet`;
    const body = replies.walletLink(link, "123456");
    expect(body).toBe(`Your wallet: ${link} Code: 123456. It works once, for 15 minutes.`);
    expect(body).toMatch(GSM);
    expect(body.length).toBeLessThanOrEqual(160);
  });
});

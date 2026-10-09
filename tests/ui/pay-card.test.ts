import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayCard } from "@/ui/patterns/PayCard/PayCard";

const base = {
  handle: "alex",
  name: "Alex",
  amountUsd: null,
  note: null,
  byText: { body: "send @alex $", uri: "sms:+18066071387?&body=send" },
  jsonUrl: "https://tmc.test/@alex.json",
};
/** QrCode is an async server component, so render with the streaming renderer and wait for all of it. */
async function render(props: Parameters<typeof PayCard>[0]): Promise<string> {
  const stream = await renderToReadableStream(createElement(PayCard, props));
  await stream.allReady;
  return new Response(stream).text();
}

const solana = { network: "Solana devnet", address: "So1Addr", uri: "solana:So1Addr", explorer: "https://explorer.test/So1Addr" };

describe("PayCard", () => {
  it("puts a Blink link next to the Solana Pay QR", async () => {
    const action = { uri: "solana-action:https://tmc.test/api/actions/pay/alex", blink: "https://dial.to/?action=x&cluster=devnet" };
    const html = await render({ ...base, chains: [{ ...solana, action }] });
    expect(html).toContain("Pay with a Solana wallet");
    expect(html).toContain('href="https://dial.to/?action=x&amp;cluster=devnet"');
    expect(html).toContain('href="solana-action:https://tmc.test/api/actions/pay/alex"');
  });

  it("shows no Blink for a chain without an action", async () => {
    const html = await render({ ...base, chains: [solana] });
    expect(html).not.toContain("Pay with a Solana wallet");
  });
});

import { site } from "./site";

/** One source for what agents need to know: used by /llms.txt and the landing page. */
export function agentFacts() {
  const s = site();
  const mcpUrl = `${s.url}/api/mcp`;
  return {
    mcpUrl,
    skillInstall: "npx skills add Dial-WTF/text-my-crypto",
    connect: `Text "connect agent" to ${s.phone}. Open the link, enter the texted code, copy the key (dial_ak_…).`,
    mcpConfig: JSON.stringify(
      { mcpServers: { dial: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer dial_ak_..." } } } },
      null,
      2,
    ),
    tools: [
      ["send_payment", "pay anyone with a phone number, @handle or name"],
      ["request_payment", "ask someone to pay you"],
      ["create_invoice", "bill a client"],
      ["get_payment", "track status and receipt"],
      ["get_balance", "USDC per chain"],
      ["withdraw", "move USDC to any address"],
      ["resolve_recipient", "contacts → directory lookup"],
      ["list_payments", "recent history"],
      ["get_pay_link", "crypto Zelle: a pay page for you or any @handle"],
      ["get_wallet", "balances, deposit addresses, activity"],
      ["list_chain_features", "what each chain can do beyond sending"],
    ] as const,
    rule: "Agents start payments. A human approves every one, by a code texted to their phone or a passkey.",
  };
}

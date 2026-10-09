import { agentFacts } from "../agent-content";
import { limitItems, settlesOn } from "../landing-content";
import { loadChainStatuses } from "../ledger-data";
import { running, site } from "../site";

export const dynamic = "force-dynamic";

/** Plain-text guide for agents and LLM crawlers (llmstxt.org). */
export async function GET(): Promise<Response> {
  const s = site();
  const a = agentFacts();
  const now = running();
  const chains = await loadChainStatuses();
  const body = `# ${s.name} by ${s.company}

> Agentic peer-to-peer crypto payments over SMS. Humans text ${s.phone}; agents use the MCP server. Send, request and invoice USDC to anyone with a phone number.${now.network === "testnet" ? " Testnet." : ""}

## For people
- Text "hi" to ${s.phone}, reply with a name, then text things like "send @jeremy $5", "request $25 from adam", "411 jeremy", "balance".
- Every payment is approved by a one-time code texted to the payer (or a passkey). Reply STOP to stop texts.
- Pay pages, crypto Zelle style: ${s.url}/@<handle> (add ?amount=5&note=pizza). Pay by text or scan with any wallet. JSON for agents at ${s.url}/@<handle>.json.
- Wallet: text "wallet" for a one-time link to ${s.url}/wallet (balances, deposit addresses, pay link, agents).

## For agents (MCP)
- Endpoint: ${a.mcpUrl} (Streamable HTTP, bearer auth)
- Get a key: ${a.connect}
- Skill: ${a.skillInstall}
- Rule: ${a.rule}
- Wallet JSON: GET ${s.url}/api/wallet with the same bearer key (read-only)

### Tools
${a.tools.map(([name, what]) => `- ${name}: ${what}`).join("\n")}

## Chains
Live: switched on and a payment has settled there. Ready: switched on, no payment settled yet. Wired: built and tested, switched off. Building: not settling yet.
${settlesOn(chains)
  .map((c) => `- ${c.name}: ${c.statusLabel}. ${c.role}`)
  .join("\n")}

## Limits
${limitItems(now.limits, now.network)
  .map((l) => `- ${l.value}: ${l.label}`)
  .join("\n")}

## Links
- Site: ${s.url}
- Ledger: ${s.url}/ledger (every settled payment, linked to its transaction)
- Ledger JSON: ${s.url}/ledger.json (payments, stats and treasury addresses)
- How it works: ${s.url}/how-it-works
- Agents: ${s.url}/agents
- Status: ${s.url}/status
- Terms: ${s.url}/terms
- Privacy: ${s.url}/privacy
- Source: ${s.source}
- Company: ${s.companyUrl}
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

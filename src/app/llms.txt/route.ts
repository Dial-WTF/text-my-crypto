import { agentFacts } from "../agent-content";
import { settlesOn } from "../landing-content";
import { site } from "../site";

export const dynamic = "force-dynamic";

/** Plain-text guide for agents and LLM crawlers (llmstxt.org). */
export function GET(): Response {
  const s = site();
  const a = agentFacts();
  const body = `# ${s.name} by ${s.company}

> Agentic peer-to-peer crypto payments over SMS. Humans text ${s.phone}; agents use the MCP server. Send, request and invoice USDC to anyone with a phone number. Testnet.

## For people
- Text "hi" to ${s.phone}, reply with a name, then text things like "send @jeremy $5", "request $25 from adam", "411 jeremy", "balance".
- Every payment is approved by a one-time code texted to the payer (or a passkey). Reply STOP to stop texts.

## For agents (MCP)
- Endpoint: ${a.mcpUrl} (Streamable HTTP, bearer auth)
- Get a key: ${a.connect}
- Skill: ${a.skillInstall}
- Rule: ${a.rule}

### Tools
${a.tools.map(([name, what]) => `- ${name}: ${what}`).join("\n")}

## Chains
${settlesOn.map((c) => `- ${c.name}: ${c.statusLabel}. ${c.role}`).join("\n")}

## Links
- Site: ${s.url}
- Ledger: ${s.url}/ledger (every settled payment, linked to its transaction)
- Ledger JSON: ${s.url}/ledger.json (payments, stats and treasury addresses)
- Source: https://github.com/Dial-WTF/text-my-crypto
- Company: ${s.companyUrl}
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

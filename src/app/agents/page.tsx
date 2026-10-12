import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section, Split } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { CodeBlock } from "@/ui/primitives/CodeBlock/CodeBlock";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { agentFacts } from "../agent-content";
import { Colophon } from "../colophon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "Let an AI agent pay, request and invoice anyone with a phone number through the Dial operator's MCP server. How to get a key, set up Claude Code or Cursor, the tools, and why a human approves every payment.",
  alternates: { canonical: "/agents" },
};

const SKILL_URL = "https://github.com/Dial-WTF/text-my-crypto/tree/main/skills/dial-operator";
const REFERENCE_URL = `${SKILL_URL}/references/tools.md`;

/** Each tool's arguments, from skills/dial-operator/references/tools.md. */
const ARGS: Record<string, string> = {
  send_payment: "to, amountUsd, note?, chain?",
  request_payment: "from, amountUsd, note?, chain?",
  create_invoice: "to, amountUsd, note?, chain?",
  get_payment: "intentId",
  get_balance: "none",
  withdraw: "amountUsd | \"all\", address, chain?",
  split_payment: "amountUsd, people[], includeMe?, note?, chain?",
  resolve_recipient: "to",
  list_payments: "limit?",
  get_pay_link: "handle?, amountUsd?, note?",
  get_wallet: "none",
  list_chain_features: "none",
  send_stock: "to, shares, symbol, note?",
  get_stocks: "none",
  send_to_hyperliquid: "amountUsd, to?",
  get_hyperliquid_balance: "none",
  get_price: "coin",
};

export default function AgentsPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const a = agentFacts();
  const claudeCode = `claude mcp add --transport http dial ${a.mcpUrl} \\\n  --header "Authorization: Bearer $DIAL_AGENT_KEY"`;
  const cursor = JSON.stringify(
    { mcpServers: { dial: { url: a.mcpUrl, headers: { Authorization: "Bearer dial_ak_..." } } } },
    null,
    2,
  );

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        level={1}
        heading="Dial for agents"
        lede="Any AI agent can pay, request money from, or invoice anyone with a phone number, through the Dial operator's MCP server. The agent starts the payment. A person approves it."
      />

      <Section heading="What agents can do">
        <Prose>
          <ul>
            <li>Send USDC to a phone number, an @handle or a name in the owner&apos;s contacts.</li>
            <li>Ask someone to pay the owner, or send them an invoice.</li>
            <li>Check balances, track payments and list recent history.</li>
            <li>Share a pay link, or read someone else&apos;s to pay them.</li>
            <li>Withdraw to an outside address.</li>
          </ul>
          <p>
            <strong>{a.rule}</strong> Every money tool creates a pending payment and texts a one-time code to whoever
            has to pay. Nothing moves until that person replies with the code or approves with their passkey. The tool
            returns <code>awaiting_approval</code>, and the agent polls <code>get_payment</code> to see what happened.
          </p>
        </Prose>
      </Section>

      <Section heading="Connect an agent">
        <Split>
          <Receipt title="1 · get a key">
            <Stack gap="sm">
              <CodeBlock code={a.connect} />
              <Fine>
                You need a Dial account first: text &ldquo;hi&rdquo; to start one. Keys look like dial_ak_… and show once.
                Text &ldquo;revoke agents&rdquo; any time to cut every key off, or revoke one from your wallet page.
              </Fine>
            </Stack>
          </Receipt>
          <Receipt title="2 · add the server">
            <Stack gap="sm">
              <ReceiptLine label="MCP">{a.mcpUrl.replace(/^https:\/\//, "")}</ReceiptLine>
              <ReceiptLine label="Transport">Streamable HTTP</ReceiptLine>
              <ReceiptLine label="Auth">bearer dial_ak_…</ReceiptLine>
              <ReceiptRule />
              <CodeBlock label="Claude Code" code={claudeCode} />
              <CodeBlock label="Claude Code · .mcp.json" code={a.mcpConfig} />
              <CodeBlock label="Cursor · ~/.cursor/mcp.json" code={cursor} />
              <CodeBlock label="Or install the skill" code={a.skillInstall} />
            </Stack>
          </Receipt>
        </Split>
      </Section>

      <Section
        heading="Tools"
        lede="Amounts are dollar strings (“10”, “2.50”) and settle as USDC. Recipients are a phone number, an @handle or a name. chain is optional and defaults to Solana."
      >
        <Receipt title="Dial operator · MCP tools">
          <Stack gap="sm">
            {a.tools.map(([name, what]) => (
              <Stack key={name} gap="2xs">
                <strong>{name}</strong>
                <Fine>
                  {what}. Arguments: {ARGS[name] ?? "none"}
                </Fine>
              </Stack>
            ))}
            <ReceiptRule />
            <Fine>
              Also: whoami (handle, chains, limits) and get_receive_address. Arguments, statuses and error codes are in
              the <a href={REFERENCE_URL}>tool reference</a>.
            </Fine>
          </Stack>
        </Receipt>
      </Section>

      <Section heading="More for agents">
        <Prose>
          <ul>
            <li>
              <a href="/llms.txt">/llms.txt</a>: the plain-text guide for agents and LLM crawlers.
            </li>
            <li>
              <a href={SKILL_URL}>The dial-operator skill</a>: install with <code>{a.skillInstall}</code>.
            </li>
            <li>
              <a href="/ledger.json">/ledger.json</a>: every settled payment, stats and treasury addresses.
            </li>
            <li>
              /@handle.json: anyone&apos;s pay page as JSON. <code>GET /api/wallet</code> with your key returns the
              owner&apos;s wallet.
            </li>
          </ul>
        </Prose>
      </Section>
    </SiteShell>
  );
}

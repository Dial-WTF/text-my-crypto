import { publicEnv } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";
import { smsUri } from "@/lib/pay-links";
import { ChainStrip } from "@/ui/patterns/ChainStrip/ChainStrip";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section, Split } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { ButtonLink } from "@/ui/primitives/Button/Button";
import { CodeBlock } from "@/ui/primitives/CodeBlock/CodeBlock";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { agentFacts } from "../agent-content";
import { codeUrl } from "../chain-content";
import { Colophon } from "../colophon";
import { settlesOn } from "../landing-content";
import { loadChainStatuses } from "../ledger-data";
import { pageMeta } from "../seo";
import { running, site } from "../site";

export const dynamic = "force-dynamic";

export const metadata = pageMeta({
  path: "/judges",
  title: "For judges",
  shareTitle: "The Dial operator, for judges",
  description:
    "What the Dial operator is, how to try it by text in a minute, how agents use it over MCP, and one page per chain with what runs there and the payments that settled.",
});

export default async function JudgesPage() {
  const s = site();
  const a = agentFacts();
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { network, limits } = running();
  const chains = await loadChainStatuses();
  const testnet = network === "testnet";
  const drop = testnet && usdToBaseUnits(limits.signupDripUsd) > 0n ? `$${limits.signupDripUsd}` : null;

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        level={1}
        heading="For judges"
        lede={`The Dial operator sends, requests and invoices stablecoins by text message. People use SMS from any phone. AI agents use an MCP server, and a person approves every payment they start.${testnet ? " Everything here runs on testnets with test money." : ""}`}
      />

      <Section heading="Try it in 60 seconds">
        <Split>
          <Receipt title="By text">
            <Stack gap="sm">
              <Fine>1 · Text hi to {s.phone}.</Fine>
              <ButtonLink href={smsUri(number, "hi")}>Text hi</ButtonLink>
              <Fine>
                2 · Reply with a name. You get an @handle{drop ? ` and ${drop} of test USDC on Solana` : ""}.
              </Fine>
              <CodeBlock label="3 · Pay someone" code="send @handle $1" />
              <Fine>
                Use a friend&apos;s @handle or phone number. Add &ldquo;on base&rdquo;, &ldquo;on tempo&rdquo; or another
                chain name to settle there.
              </Fine>
              <Fine>4 · Reply with the 6-digit code it texts you. The receipt links the transaction.</Fine>
            </Stack>
          </Receipt>
          <Receipt title="For agents">
            <Stack gap="sm">
              <ReceiptLine label="MCP">{a.mcpUrl.replace(/^https:\/\//, "")}</ReceiptLine>
              <ReceiptLine label="Auth">bearer dial_ak_…</ReceiptLine>
              <CodeBlock label="Get a key" code={a.connect} />
              <Fine>{a.rule}</Fine>
              <ReceiptRule />
              <Fine>
                Programmable by chain: chain-native features such as on-chain escrow are optional modules on each
                chain&apos;s adapter. Agents list them per chain with the list_chain_features tool.{" "}
                <a href={codeUrl(s.source, "docs/CAPABILITIES.md")}>docs/CAPABILITIES.md</a>
              </Fine>
              <Fine>
                Setup for Claude Code and Cursor, and every tool: <a href="/agents">/agents</a>.
              </Fine>
            </Stack>
          </Receipt>
        </Split>
      </Section>

      <ChainStrip heading="One page per chain" items={settlesOn(chains, { branded: true })} size="large" />

      <Section heading="Check it">
        <Prose>
          <p>
            Live means a payment has settled on that chain. Ready means it is switched on with nothing settled yet,
            Wired means it is built and switched off, and Building means it isn&apos;t settling yet.
          </p>
          <ul>
            <li>
              <a href="/ledger">Ledger</a>: every payment, linked to its transaction. As JSON at{" "}
              <a href="/ledger.json">/ledger.json</a>.
            </li>
            <li>
              <a href="/status">Status</a>: the database, texting and every chain, checked now.
            </li>
            <li>
              <a href="/how-it-works">How it works</a>: codes, passkeys, escrow, limits and custody.
            </li>
            <li>
              <a href="/agents">Agents</a>: the MCP server, keys and tools.
            </li>
            <li>
              <a href={s.source}>Source on GitHub</a> (AGPL-3.0).
            </li>
          </ul>
        </Prose>
      </Section>
    </SiteShell>
  );
}

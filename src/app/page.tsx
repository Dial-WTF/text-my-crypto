import { publicEnv } from "@/lib/env";
import { formatUsd } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { smsUri } from "@/lib/pay-links";
import { AgentPanel } from "@/ui/patterns/AgentPanel/AgentPanel";
import { ChainStrip } from "@/ui/patterns/ChainStrip/ChainStrip";
import { DemoVideo } from "@/ui/patterns/DemoVideo/DemoVideo";
import { Limits } from "@/ui/patterns/Limits/Limits";
import { Marquee } from "@/ui/patterns/Marquee/Marquee";
import { OnchainProof } from "@/ui/patterns/OnchainProof/OnchainProof";
import { PoweredBy } from "@/ui/patterns/PoweredBy/PoweredBy";
import { PaymentFeed } from "@/ui/patterns/PaymentFeed/PaymentFeed";
import { QrReceipt } from "@/ui/patterns/QrReceipt/QrReceipt";
import { Section, Split } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { SmsConsent } from "@/ui/patterns/SmsConsent/SmsConsent";
import { StatStrip } from "@/ui/patterns/StatStrip/StatStrip";
import { Transcript } from "@/ui/patterns/Transcript/Transcript";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { agentFacts } from "./agent-content";
import { Colophon } from "./colophon";
import { DEMO_VIDEO, PITCH_VIDEO } from "./demo-video";
import { limitItems, runsOn, settlesOn, transcript } from "./landing-content";
import { loadChainStatuses, loadLedger } from "./ledger-data";
import { pageMeta } from "./seo";
import { running, site } from "./site";
import { StructuredData } from "./StructuredData";

export const dynamic = "force-dynamic";

const s = site();
export const metadata = pageMeta({ path: "/", title: { absolute: `${s.fullName} · ${s.title}` }, shareTitle: s.title });

export default async function Home() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { stats, feed, proofs, note } = await loadLedger(8);
  const { network, limits } = running();
  const chains = await loadChainStatuses();
  const stat = (v: string | number | undefined) => (stats ? String(v) : "—");

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <StructuredData />
      <Marquee
        kicker="Text the Dial operator"
        number={formatPhone(number)}
        href={smsUri(number, "hi")}
        line="Send, request and invoice crypto by text. No app. No wallet address. Works on any phone."
        fine={<SmsConsent />}
      />

      <PoweredBy
        company="Dial.Work"
        href="https://dial.work"
        line="Agentic peer-to-peer crypto payments, by SMS for people and MCP for agents. Built for Colosseum's Crypto World's Fair."
      />

      <Section heading="Watch a real payment">
        <DemoVideo {...DEMO_VIDEO} />
      </Section>

      <ChainStrip heading="Settles on" items={settlesOn(chains)} size="large" />
      <ChainStrip heading="Runs on" items={runsOn} />

      <Section heading="Say hi. That's the signup.">
        <Split>
          <QrReceipt number={number} body="hi" />
          <Transcript lines={transcript} label="Example conversation with the Dial operator" />
        </Split>
      </Section>

      <Section
        heading="Limits"
        lede={network === "testnet" ? "Kept small on purpose while Dial is a testnet demo." : "Kept small on purpose."}
      >
        <Limits items={limitItems(limits, network)} />
      </Section>

      <Section
        heading="Built for agents too"
        lede="Any AI agent can pay, request or invoice anyone with a phone number through the Dial operator's MCP server. Agents start payments; a human approves every one from a text."
      >
        <AgentPanel {...agentFacts()} />
      </Section>

      <Section heading="Why we built it">
        <DemoVideo {...PITCH_VIDEO} />
      </Section>

      <Section heading="On the ledger right now">
        <Stack gap="lg">
          <StatStrip
            items={[
              { value: stat(stats?.payments), label: "payments settled" },
              { value: stats ? formatUsd(stats.movedUsd) : "—", label: "moved by text" },
              { value: stat(stats?.people), label: "people on Dial" },
            ]}
          />
          <Split>
            <PaymentFeed entries={feed} emptyText="No payments yet. Text “hi” to send one." />
            <OnchainProof rows={proofs} note={note} more={{ href: "/ledger", label: "Full ledger →" }} />
          </Split>
        </Stack>
      </Section>

    </SiteShell>
  );
}

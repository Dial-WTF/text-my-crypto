import { chainLabel } from "@/lib/chains";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { formatUsd } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { type PublicStats, publicStats, recentPayments } from "@/lib/stats";
import { ComparisonSheet } from "@/ui/patterns/ComparisonSheet/ComparisonSheet";
import { Marquee } from "@/ui/patterns/Marquee/Marquee";
import { type FeedEntry, PaymentFeed } from "@/ui/patterns/PaymentFeed/PaymentFeed";
import { QrReceipt } from "@/ui/patterns/QrReceipt/QrReceipt";
import { Section, Split } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { StatStrip } from "@/ui/patterns/StatStrip/StatStrip";
import { Transcript } from "@/ui/patterns/Transcript/Transcript";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { comparison, transcript } from "./landing-content";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = { settled: "delivered", escrowed: "waiting to be claimed", refunded: "refunded" };

async function loadLedger(): Promise<{ stats: PublicStats | null; feed: FeedEntry[] }> {
  try {
    const db = getDb();
    const [stats, rows] = await Promise.all([publicStats(db), recentPayments(db, 8)]);
    const feed = rows.map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      amount: r.amount,
      network: `${chainLabel(r.chain)} devnet`,
      state: STATE_LABEL[r.status] ?? r.status,
      txHash: r.txHash,
      explorerUrl: r.explorerUrl,
    }));
    return { stats, feed };
  } catch (e) {
    console.error("ledger unavailable", e);
    return { stats: null, feed: [] };
  }
}

export default async function Home() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { stats, feed } = await loadLedger();
  const stat = (v: string | number | undefined) => (stats ? String(v) : "—");

  return (
    <SiteShell
      operatorNumber={number}
      colophon={
        <>
          <p>Testnet demo. Payments settle in devnet USDC on Solana; Tempo, Base and Zcash are on the way.</p>
          <p>
            Wallets are held by Dial and every movement needs a one-time code texted to your phone, or your passkey. Text
            “withdraw all to &lt;address&gt;” to take your money anywhere.
          </p>
          <p>Text My Bits (2020) → the Dial operator (2026). Texts run on Payphone.</p>
        </>
      }
    >
      <Marquee
        kicker="Text the Dial operator"
        number={formatPhone(number)}
        href={`sms:${number}?&body=hi`}
        line="Send, request and invoice crypto by text. No app. No wallet address. Works on any phone."
      />

      <Section heading="Say hi. That's the signup.">
        <Split>
          <QrReceipt number={number} body="hi" />
          <Transcript lines={transcript} label="Example conversation with the Dial operator" />
        </Split>
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
          <PaymentFeed entries={feed} emptyText="No payments yet. Text “hi” and be the first." />
        </Stack>
      </Section>

      <Section
        heading="Text My Bits, rebuilt"
        lede="In 2020, Text My Bits proved money could move over SMS. Here is what changed."
      >
        <ComparisonSheet caption="Text My Bits compared with the Dial operator" beforeLabel="Text My Bits · 2020" afterLabel="Dial operator · 2026" rows={comparison} />
      </Section>
    </SiteShell>
  );
}

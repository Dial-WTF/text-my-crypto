import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { formatUsd } from "@/lib/money";
import { OnchainProof } from "@/ui/patterns/OnchainProof/OnchainProof";
import { PaymentFeed } from "@/ui/patterns/PaymentFeed/PaymentFeed";
import { Section, Split } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { StatStrip } from "@/ui/patterns/StatStrip/StatStrip";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Colophon } from "../colophon";
import { loadLedger } from "../ledger-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ledger",
  description: "Every payment the Dial operator has settled by text, each linked to its on-chain transaction.",
  alternates: { canonical: "/ledger" },
};

export default async function LedgerPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { stats, feed, proofs, note } = await loadLedger(100);
  const stat = (v: string | number | undefined) => (stats ? String(v) : "—");

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        heading="The ledger"
        lede="Every payment the Dial operator has settled by text, newest first. Each one links to its transaction, and the same list is at /ledger.json for agents."
      >
        <Stack gap="lg">
          <StatStrip
            items={[
              { value: stat(stats?.payments), label: "payments settled" },
              { value: stats ? formatUsd(stats.movedUsd) : "—", label: "moved by text" },
              { value: stat(stats?.people), label: "people on Dial" },
            ]}
          />
          <Split>
            <PaymentFeed entries={feed} emptyText="No payments yet. Text “hi” and be the first." />
            <OnchainProof rows={proofs} note={note} more={{ href: "/ledger.json", label: "Ledger as JSON →" }} />
          </Split>
        </Stack>
      </Section>
    </SiteShell>
  );
}

import type { Metadata } from "next";
import { peekAgentLink } from "@/lib/agents/keys";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { getUserById } from "@/lib/identity";
import { AgentKeyClaim } from "@/ui/patterns/AgentKeyClaim/AgentKeyClaim";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { Notice } from "@/ui/patterns/Notice/Notice";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import { redeemAgentKey } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect an agent", robots: { index: false } };

export default async function AgentKeyPage({ params }: PageProps<"/k/[token]">) {
  const { token } = await params;
  const db = getDb();
  const link = await peekAgentLink(db, token, new Date());
  const user = link ? await getUserById(db, link.userId) : null;

  return (
    <SiteShell operatorNumber={publicEnv().DIAL_OPERATOR_NUMBER}>
      <Desk
        heading="Connect an agent"
        lede="Your agent can check your balance and ask for payments. Every payment still waits for you to approve it by text or passkey."
      >
        <Receipt title="Dial operator · agent key">
          {link && user ? (
            <>
              <ReceiptLine label="Account">{user.handle ?? "you"}</ReceiptLine>
              <ReceiptLine label="Agent">{link.label}</ReceiptLine>
              <ReceiptLine label="Can">read, ask to pay</ReceiptLine>
              <ReceiptLine label="Can't">approve payments</ReceiptLine>
              <AgentKeyClaim token={token} redeem={redeemAgentKey} />
            </>
          ) : (
            <Notice tone="info">This link expired or was already used. Text “connect agent” to the operator for a new one.</Notice>
          )}
        </Receipt>
      </Desk>
    </SiteShell>
  );
}

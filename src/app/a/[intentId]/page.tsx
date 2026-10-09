import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { getIntent } from "@/lib/intents";
import { buildPaymentView } from "@/lib/views/payment";
import { ApprovePanel } from "@/ui/patterns/ApprovePanel/ApprovePanel";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { PaymentReceipt } from "@/ui/patterns/PaymentReceipt/PaymentReceipt";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { approveWithCode, beginPasskeyApproval, finishPasskeyApproval } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Payment", robots: { index: false } };

export default async function PaymentPage({ params }: PageProps<"/a/[intentId]">) {
  const { intentId } = await params;
  const db = getDb();
  const intent = await getIntent(db, intentId);
  if (!intent) notFound();
  const view = await buildPaymentView(db, intent, new Date());

  return (
    <SiteShell operatorNumber={publicEnv().DIAL_OPERATOR_NUMBER}>
      <Desk heading={view.approve ? "Approve this payment" : view.kindLabel}>
        <PaymentReceipt view={view}>
          {view.approve ? (
            <ApprovePanel
              intentId={view.id}
              passkey={view.approve.passkey}
              code={view.approve.code}
              actions={{ beginPasskey: beginPasskeyApproval, finishPasskey: finishPasskeyApproval, approveWithCode }}
            />
          ) : null}
        </PaymentReceipt>
      </Desk>
    </SiteShell>
  );
}

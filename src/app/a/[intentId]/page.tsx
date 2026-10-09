import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { env, publicEnv } from "@/lib/env";
import { getIntent } from "@/lib/intents";
import { buildPaymentView } from "@/lib/views/payment";
import { loadReceiptCard, receiptWords } from "@/lib/web/receipt-card";
import { ApprovePanel } from "@/ui/patterns/ApprovePanel/ApprovePanel";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { PaymentReceipt } from "@/ui/patterns/PaymentReceipt/PaymentReceipt";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../../colophon";
import { pageMeta } from "../../seo";
import { approveWithCode, beginPasskeyApproval, finishPasskeyApproval } from "./actions";

export const dynamic = "force-dynamic";

/** The preview uses the share-card view: @handles only and no note, even while the payment is pending. */
export async function generateMetadata({ params }: PageProps<"/a/[intentId]">): Promise<Metadata> {
  const { intentId } = await params;
  const path = `/a/${encodeURIComponent(intentId)}`;
  const view = await loadReceiptCard(intentId).catch(() => null);
  if (!view) return pageMeta({ path, title: "Payment", index: false });
  const { title, description } = receiptWords(view);
  return pageMeta({
    path,
    title: view.kindLabel,
    shareTitle: title,
    description,
    index: false,
    image: { url: `${path}/card`, width: 1200, height: 630, alt: title },
  });
}

export default async function PaymentPage({ params }: PageProps<"/a/[intentId]">) {
  const { intentId } = await params;
  const db = getDb();
  const intent = await getIntent(db, intentId);
  if (!intent) notFound();
  const view = await buildPaymentView(db, intent, new Date(), { network: env().NETWORK, audience: "public" });

  return (
    <SiteShell operatorNumber={publicEnv().DIAL_OPERATOR_NUMBER} colophon={<Colophon />}>
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

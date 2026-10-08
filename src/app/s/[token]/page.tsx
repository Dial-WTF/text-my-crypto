import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { findUserByPhone, isClaimed, peekSignupToken } from "@/lib/identity";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { Notice } from "@/ui/patterns/Notice/Notice";
import { PasskeySetup } from "@/ui/patterns/PasskeySetup/PasskeySetup";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import { beginPasskeySetup, finishPasskeySetup } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Add a passkey · Dial operator", robots: { index: false } };

export default async function PasskeyPage({ params }: PageProps<"/s/[token]">) {
  const { token } = await params;
  const db = getDb();
  const phone = await peekSignupToken(db, token, new Date());
  const user = phone ? await findUserByPhone(db, phone) : null;
  const ready = user && isClaimed(user) && user.handle;

  return (
    <SiteShell operatorNumber={publicEnv().DIAL_OPERATOR_NUMBER}>
      <Desk
        heading="Add a passkey"
        lede="One tap with your face or fingerprint approves payments. Your texts keep working for small ones."
      >
        <Receipt title="Dial operator · upgrade">
          {ready ? (
            <>
              <ReceiptLine label="Account">{user.handle}</ReceiptLine>
              <ReceiptLine label="Over $20">passkey</ReceiptLine>
              <ReceiptLine label="Up to $20">passkey or code</ReceiptLine>
              <PasskeySetup token={token} actions={{ begin: beginPasskeySetup, finish: finishPasskeySetup }} />
            </>
          ) : (
            <Notice tone="info">This link expired or was already used. Text “upgrade” to the operator for a new one.</Notice>
          )}
        </Receipt>
      </Desk>
    </SiteShell>
  );
}

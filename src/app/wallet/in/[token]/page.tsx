import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { loginLinkOpen } from "@/lib/web/sessions";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { WalletCodeForm, WalletLinkClosed } from "@/ui/patterns/WalletSignIn/WalletSignIn";
import { Colophon } from "../../../colophon";
import { signInWithCode } from "../../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Open your wallet", robots: { index: false } };

export default async function WalletLinkPage({ params, searchParams }: PageProps<"/wallet/in/[token]">) {
  const { token } = await params;
  const { error } = (await searchParams) as { error?: string };
  const open = await loginLinkOpen(getDb(), token, new Date());

  return (
    <SiteShell operatorNumber={publicEnv().DIAL_OPERATOR_NUMBER} colophon={<Colophon />}>
      <Desk heading="Open your wallet" lede="Enter the 6-digit code from the operator's text. It keeps a forwarded link from opening your wallet.">
        {open ? (
          <WalletCodeForm
            token={token}
            action={signInWithCode}
            error={error === "code" ? "That code didn't match. Check the operator's last text." : null}
          />
        ) : (
          <WalletLinkClosed />
        )}
      </Desk>
    </SiteShell>
  );
}

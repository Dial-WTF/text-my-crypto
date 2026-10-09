import type { Metadata } from "next";
import { botDeps } from "@/lib/deps";
import { publicEnv } from "@/lib/env";
import { formatUsd } from "@/lib/money";
import { smsUri } from "@/lib/pay-links";
import { walletView } from "@/lib/views/wallet";
import { currentUser } from "@/lib/web/current";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { WalletPanel } from "@/ui/patterns/WalletPanel/WalletPanel";
import { WalletSignIn } from "@/ui/patterns/WalletSignIn/WalletSignIn";
import { Colophon } from "../colophon";
import { passkeyFinish, passkeyOptions, revokeAgent, signOut } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Wallet", robots: { index: false } };

const STATUS: Record<string, string> = {
  pending: "awaiting approval",
  settling: "sending",
  escrowed: "waiting to be claimed",
  settled: "delivered",
  refunded: "refunded",
  failed: "failed",
  declined: "declined",
};

const when = (d: Date | null) => (d ? `used ${d.toISOString().slice(0, 10)}` : "never used");

export default async function WalletPage() {
  const number = publicEnv().DIAL_OPERATOR_NUMBER;
  const user = await currentUser();

  if (!user) {
    return (
      <SiteShell operatorNumber={number} colophon={<Colophon />}>
        <Desk
          heading="Your wallet"
          lede="See your balances, deposit from any wallet, share your pay link and manage your agents. Moving money still takes a texted code."
        >
          <WalletSignIn smsUri={smsUri(number, "wallet")} passkey={{ options: passkeyOptions, finish: passkeyFinish }} />
        </Desk>
      </SiteShell>
    );
  }

  const v = await walletView(botDeps(), user);
  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Desk heading={`Hi, ${v.name}`} lede="Your Dial wallet. Share your pay link to get paid; deposit from any wallet app.">
        <WalletPanel
          handle={v.handle}
          payUrl={v.payUrl}
          chains={v.chains.map((c) => ({ ...c, balance: c.balance === null ? null : formatUsd(c.balance) }))}
          activity={v.activity.map((a) => ({
            id: a.id,
            from: a.direction === "in" ? a.other : "you",
            to: a.direction === "in" ? "you" : a.other,
            amount: a.amount,
            network: a.network,
            state: STATUS[a.status] ?? a.status,
            txHash: a.txHash,
            explorerUrl: a.explorerUrl,
          }))}
          agents={v.agents.map((a) => ({ id: a.id, label: a.label, lastUsed: when(a.lastUsedAt) }))}
          passkey={v.passkey}
          revokeAgent={revokeAgent}
          signOut={signOut}
        />
      </Desk>
    </SiteShell>
  );
}

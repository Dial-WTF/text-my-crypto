import { botDeps } from "@/lib/deps";
import { publicEnv } from "@/lib/env";
import { formatUsd } from "@/lib/money";
import { money } from "@/lib/settlement/amounts";
import { stateLabel, timeAgo } from "@/lib/payment-labels";
import { smsUri } from "@/lib/pay-links";
import { walletView } from "@/lib/views/wallet";
import { currentUser } from "@/lib/web/current";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { WalletPanel } from "@/ui/patterns/WalletPanel/WalletPanel";
import { WalletSignIn } from "@/ui/patterns/WalletSignIn/WalletSignIn";
import { Colophon } from "../colophon";
import { pageMeta } from "../seo";
import { passkeyFinish, passkeyOptions, revokeAgent, signOut } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = pageMeta({
  path: "/wallet",
  title: "Wallet",
  description: "Your Dial wallet: balances, deposit addresses, your pay link and your agents. Text “wallet” to the operator to open it.",
  index: false,
});

const FAUCET = { href: "https://faucet.circle.com", label: "faucet.circle.com" };

const lastUsed = (d: Date | null, now: Date) => (d ? `used ${timeAgo(d, now)}` : "never used");

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

  const deps = botDeps();
  const now = deps.now();
  const v = await walletView(deps, user);
  const readable = v.chains.filter((c) => c.balance !== null && c.asset === "USDC");
  const total = readable.reduce((sum, c) => sum + (c.balance ?? 0n), 0n);

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Desk heading={`Hi, ${v.name}`} lede="Your Dial wallet. Share your pay link to get paid; deposit from any wallet app.">
        <WalletPanel
          handle={v.handle}
          total={readable.length ? formatUsd(total) : null}
          faucet={deps.network === "testnet" && readable.length && total === 0n ? FAUCET : null}
          payUrl={v.payUrl}
          chains={v.chains.map((c) => ({ ...c, balance: c.balance === null ? null : money(c.balance, c.chain, deps.network) }))}
          activity={v.activity.map((a) => ({
            id: a.id,
            from: a.direction === "in" ? a.other : "you",
            to: a.direction === "in" ? "you" : a.other,
            amount: a.amount,
            network: a.network,
            state: stateLabel(a.status, a.expiresAt, now),
            txHash: a.txHash,
            explorerUrl: a.explorerUrl,
            when: timeAgo(a.at, now),
            ...(a.waitingOnYou ? { action: { href: `/a/${a.id}`, label: "Approve →" } } : {}),
          }))}
          agents={v.agents.map((a) => ({ id: a.id, label: a.label, lastUsed: lastUsed(a.lastUsedAt, now) }))}
          passkey={v.passkey}
          revokeAgent={revokeAgent}
          signOut={signOut}
        />
      </Desk>
    </SiteShell>
  );
}

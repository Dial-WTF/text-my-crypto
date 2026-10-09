import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicEnv } from "@/lib/env";
import { payActionUrl, solanaActionLinks } from "@/lib/pay-links";
import { REGISTRY } from "@/lib/settlement/registry";
import { loadPayHeader, payWords } from "@/lib/web/pay-page";
import { BlinkCheckout } from "@/ui/patterns/BlinkCheckout/BlinkCheckout";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../../../colophon";
import { pageMeta } from "../../../seo";

export const dynamic = "force-dynamic";

type Query = { amount?: string; note?: string };

export async function generateMetadata({ params, searchParams }: PageProps<"/pay/[handle]/blink">): Promise<Metadata> {
  const head = await loadPayHeader((await params).handle, (await searchParams) as Query);
  if (!head) return { title: "Pay on Dial", robots: { index: false } };
  const { title, description } = payWords(head);
  // The pay page at /@handle is the one to index and share; this is its wallet checkout.
  return pageMeta({ path: `/@${head.handle}/blink`, title: { absolute: `${title} · Solana wallet` }, description, index: false });
}

/**
 * The pay link's Solana Action, rendered on this site: the Blink checkout. It only ever loads this
 * handle's own action from this site; nothing in the query string names a URL.
 */
export default async function BlinkPage({ params, searchParams }: PageProps<"/pay/[handle]/blink">) {
  const head = await loadPayHeader((await params).handle, (await searchParams) as Query);
  if (!head) notFound();
  const env = publicEnv();
  const solana = REGISTRY.solana[env.NETWORK];
  if (solana?.kind !== "solana") notFound();
  const testnet = env.NETWORK === "testnet";

  return (
    <SiteShell operatorNumber={env.DIAL_OPERATOR_NUMBER} colophon={<Colophon />}>
      <Desk
        heading={`Pay ${head.name}`}
        lede={`Connect a Solana wallet in this browser, pick an amount and approve it. ${testnet ? "Test USDC on Solana devnet." : "USDC on Solana."}`}
      >
        <BlinkCheckout
          handle={head.handle}
          actionPath={payActionUrl("", head.handle, head)}
          appOrigin={new URL(env.APP_URL).origin}
          chain={testnet ? "solana:devnet" : "solana:mainnet"}
          rpcUrl={solana.publicRpc}
          explorerTx={solana.explorerTx("{signature}")}
          testnet={testnet}
          actionUri={solanaActionLinks(env.APP_URL, head.handle, head).uri}
        />
      </Desk>
    </SiteShell>
  );
}

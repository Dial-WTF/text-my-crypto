import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicEnv } from "@/lib/env";
import { handleFromParam, loadPayProfile } from "@/lib/web/pay-page";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { PayCard } from "@/ui/patterns/PayCard/PayCard";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../../colophon";

export const dynamic = "force-dynamic";

type Query = { amount?: string; note?: string };

export async function generateMetadata({ params }: PageProps<"/pay/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  const h = handleFromParam(handle);
  if (!h) notFound();
  return {
    title: `Pay @${h}`,
    description: `Pay @${h} by text from any phone, or from any crypto wallet. Powered by the Dial operator.`,
    alternates: { canonical: `/@${h}`, types: { "application/json": `/@${h}.json` } },
  };
}

export default async function PayPage({ params, searchParams }: PageProps<"/pay/[handle]">) {
  const { handle } = await params;
  const q = (await searchParams) as Query;
  const profile = await loadPayProfile(handle, q);
  if (!profile) notFound();

  return (
    <SiteShell operatorNumber={publicEnv().DIAL_OPERATOR_NUMBER} colophon={<Colophon />}>
      <Desk
        heading={`Pay ${profile.name}`}
        lede="Text the Dial operator from any phone, or scan with any crypto wallet. Test USDC only: this is a testnet demo."
      >
        <PayCard
          handle={profile.handle}
          name={profile.name}
          amountUsd={profile.amountUsd}
          note={profile.note}
          byText={profile.byText}
          chains={profile.chains}
          jsonUrl={`${profile.url.split("?")[0]}.json`}
        />
      </Desk>
    </SiteShell>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicEnv } from "@/lib/env";
import { askQuery, loadPayHeader, loadPayProfile, payWords } from "@/lib/web/pay-page";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { PayCard } from "@/ui/patterns/PayCard/PayCard";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../../colophon";

export const dynamic = "force-dynamic";

type Query = { amount?: string; note?: string };

export async function generateMetadata({ params, searchParams }: PageProps<"/pay/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  const q = (await searchParams) as Query;
  const head = await loadPayHeader(handle, q);
  if (!head) return { title: "Pay on Dial", robots: { index: false } };
  const { title, description } = payWords(head);
  const qs = askQuery(head);
  const image = { url: `/pay/${head.handle}/card${qs}`, width: 1200, height: 630, alt: title };
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/@${head.handle}`, types: { "application/json": `/@${head.handle}.json` } },
    openGraph: { type: "website", siteName: "Dial operator", title, description, url: `/@${head.handle}${qs}`, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
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
          jsonUrl={`${profile.url.replace(/\?.*$/, "")}.json`}
        />
      </Desk>
    </SiteShell>
  );
}

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { publicEnv } from "@/lib/env";
import { smsUri } from "@/lib/pay-links";
import { formatPhone } from "@/lib/phone";
import { currentUser } from "@/lib/web/current";
import { loadPayHeader } from "@/lib/web/pay-page";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { codeError, WalletCodeForm } from "@/ui/patterns/WalletSignIn/WalletSignIn";
import { Colophon } from "../../../colophon";
import { pageMeta } from "../../../seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/pay/[handle]/wallet">): Promise<Metadata> {
  const head = await loadPayHeader((await params).handle, {});
  if (!head) return { title: "Wallet", robots: { index: false } };
  return pageMeta({
    path: `/@${head.handle}/wallet`,
    title: "Open your wallet",
    description: "Sign in to your Dial wallet with the code the operator texts you.",
    index: false,
  });
}

/**
 * /@handle/wallet: the owner's permanent wallet link. Text WALLET for a code, enter it here. The page only
 * exists for handles the public pay page already shows.
 */
export default async function HandleWalletPage({ params, searchParams }: PageProps<"/pay/[handle]/wallet">) {
  const head = await loadPayHeader((await params).handle, {});
  if (!head) notFound();
  if ((await currentUser())?.handle === head.handle) redirect("/wallet");
  const { error } = (await searchParams) as { error?: string };
  const number = publicEnv().DIAL_OPERATOR_NUMBER;

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Desk heading="Open your wallet" lede={`@${head.handle}'s Dial wallet. Enter the 6-digit code from the operator's text.`}>
        <WalletCodeForm
          who={{ handle: head.handle }}
          error={codeError(error)}
          getCode={{ smsUri: smsUri(number, "wallet"), number: formatPhone(number) }}
        />
      </Desk>
    </SiteShell>
  );
}

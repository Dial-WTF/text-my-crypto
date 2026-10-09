import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "./colophon";
import { FallbackBody } from "./fallback";

export const metadata: Metadata = { title: "Not found", robots: { index: false } };

/** Every 404: unknown paths, and pages that call notFound() (an unknown /@handle, a bogus /a/<id>). */
export default function NotFound() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <FallbackBody
        heading="Nothing here"
        lede="That page doesn't exist. Pay links only work for people on Dial, and payment links for real payments."
        title="404 · not found"
        operatorNumber={number}
        fine="Got this from a text? Text the operator and it'll send you a fresh link."
      />
    </SiteShell>
  );
}

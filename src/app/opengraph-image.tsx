import { ImageResponse } from "next/og";
import { CARD_SIZE, fontsFor, markDataUrl, ShareFrame, SOFT, terminalFont } from "./press/art";
import { liveChainNames } from "@/lib/chain-status";
import { running, site } from "./site";

// Rendered on request, so the chains it names are the ones running, not the ones at build time.
export const dynamic = "force-dynamic";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const alt = site().shareAlt;

export default async function OpenGraphImage() {
  const s = site();
  const [font, mark] = await Promise.all([terminalFont(), markDataUrl()]);
  const { chains } = running();
  const live = liveChainNames(chains);
  const more = chains.length - live.length;
  return new ImageResponse(
    (
      <ShareFrame
        mark={mark}
        family={font ? "Terminal" : "sans-serif"}
        tag={live.length ? `LIVE · ${live.join(" + ").toUpperCase()}` : "TESTNET DEMO"}
        aside={more ? `${more} more chain${more === 1 ? "" : "s"} on the way` : "crypto by text"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 34, color: SOFT }}>Text the operator</div>
          <div style={{ display: "flex", fontSize: 118, letterSpacing: -2, textShadow: "0 0 24px rgba(0,255,65,0.55)" }}>{s.phone}</div>
          <div style={{ display: "flex", fontSize: 34 }}>Send, request and invoice crypto by SMS.</div>
          <div style={{ display: "flex", fontSize: 34, color: SOFT }}>No app. No wallet address. Any phone.</div>
        </div>
      </ShareFrame>
    ),
    { ...CARD_SIZE, fonts: fontsFor(font), headers: { "cache-control": "public, max-age=3600, s-maxage=3600" } },
  );
}

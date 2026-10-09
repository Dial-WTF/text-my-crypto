import { ImageResponse } from "next/og";
import { enabledChainNames } from "@/lib/chain-status";
import { CARD_SIZE, fontsFor, markDataUrl, ShareFrame, SOFT, terminalFont } from "./press/art";
import { running, site } from "./site";

// Built once, without the ledger, so it names the chains switched on neutrally and never says "live".
export const dynamic = "force-static";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const alt = site().shareAlt;

export default async function OpenGraphImage() {
  const s = site();
  const [font, mark] = await Promise.all([terminalFont(), markDataUrl()]);
  const { chains } = running();
  const on = enabledChainNames(chains).map((n) => n.replace(/ Chain$/, ""));
  const more = chains.length - on.length;
  return new ImageResponse(
    (
      <ShareFrame
        mark={mark}
        family={font ? "Terminal" : "sans-serif"}
        tag={on.length ? `SETTLES ON ${on.join(" · ").toUpperCase()}` : "TESTNET DEMO"}
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
    { ...CARD_SIZE, fonts: fontsFor(font) },
  );
}

import { ImageResponse } from "next/og";
import { CARD_SIZE, fontsFor, markDataUrl, ShareFrame, SOFT, terminalFont } from "./press/art";
import { site } from "./site";

export const dynamic = "force-static";
export const size = CARD_SIZE;
export const contentType = "image/png";
export const alt = site().shareAlt;

export default async function OpenGraphImage() {
  const s = site();
  const [font, mark] = await Promise.all([terminalFont(), markDataUrl()]);
  return new ImageResponse(
    (
      <ShareFrame
        mark={mark}
        family={font ? "Terminal" : "sans-serif"}
        tag="LIVE · SOLANA + TEMPO"
        aside="Base · Ethereum · Arbitrum · Hyperliquid · Robinhood next"
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

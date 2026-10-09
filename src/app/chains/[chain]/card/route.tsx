import { ImageResponse } from "next/og";
import { parseChain } from "@/lib/chains";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { LOGO_PATHS } from "@/ui/brand/logoPaths";
import { CHAIN_COPY } from "../../../chain-content";
import { CARD_SIZE, fontsFor, GREEN, markDataUrl, ShareFrame, SOFT, terminalFont } from "../../../press/art";

export const dynamic = "force-dynamic";

/**
 * The share card for /chains/<chain>: the chain and what the operator does there, from the static copy.
 * Never its status: a cached preview would go on saying "Live" or "Ready" after it changed.
 */
export async function GET(_req: Request, ctx: RouteContext<"/chains/[chain]/card">): Promise<Response> {
  const { chain: slug } = await ctx.params;
  const chain = parseChain(decodeURIComponent(slug));
  const [font, mark] = await Promise.all([terminalFont(), markDataUrl()]);
  const phone = formatPhone(publicEnv().DIAL_OPERATOR_NUMBER);
  const glow = { textShadow: "0 0 24px rgba(0,255,65,0.55)" };
  const copy = chain ? CHAIN_COPY[chain] : null;
  const logo = copy ? LOGO_PATHS[copy.logo] : null;

  return new ImageResponse(
    (
      <ShareFrame mark={mark} family={font ? "Terminal" : "sans-serif"} tag={`TEXT ${phone}`} aside="send · request · invoice by SMS">
        {copy && logo ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", fontSize: 34, color: SOFT }}>The Dial operator on</div>
            <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
              <svg viewBox={logo.viewBox} width={104} height={104} fill={GREEN}>
                <path d={logo.d} />
              </svg>
              <div style={{ display: "flex", fontSize: copy.name.length > 12 ? 92 : 118, letterSpacing: -2, ...glow }}>{copy.name}</div>
            </div>
            <div style={{ display: "flex", fontSize: 32, maxWidth: 1040 }}>{copy.summary}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", fontSize: 96, ...glow }}>Pay anyone by text</div>
            <div style={{ display: "flex", fontSize: 34, color: SOFT }}>Send, request and invoice crypto by SMS.</div>
          </div>
        )}
      </ShareFrame>
    ),
    { ...CARD_SIZE, fonts: fontsFor(font), headers: { "cache-control": "public, max-age=3600, s-maxage=3600" } },
  );
}

import { ImageResponse } from "next/og";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { loadPayHeader } from "@/lib/web/pay-page";
import { CARD_SIZE, fontsFor, markDataUrl, ShareFrame, SOFT, terminalFont } from "../../../press/art";

export const dynamic = "force-dynamic";

/** Big enough to read in a chat preview, small enough that a 32-character handle still fits. */
const handleSize = (h: string) => (h.length <= 10 ? 124 : h.length <= 16 ? 96 : 68);

/** The share card for /@handle: who to pay, what they asked for, and how. Unknown handles get a plain Dial card. */
export async function GET(req: Request, ctx: RouteContext<"/pay/[handle]/card">): Promise<Response> {
  const { handle } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const [head, font, mark] = await Promise.all([
    loadPayHeader(handle, { amount: q.get("amount"), note: q.get("note") }).catch(() => null),
    terminalFont(),
    markDataUrl(),
  ]);
  const phone = formatPhone(publicEnv().DIAL_OPERATOR_NUMBER);
  const glow = { textShadow: "0 0 24px rgba(0,255,65,0.55)" };

  return new ImageResponse(
    (
      <ShareFrame
        mark={mark}
        family={font ? "Terminal" : "sans-serif"}
        tag={`TEXT ${phone}`}
        aside="or scan with any wallet · Solana · Tempo"
      >
        {head ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", fontSize: 38, color: SOFT }}>Pay</div>
            <div style={{ display: "flex", fontSize: handleSize(head.handle), letterSpacing: -2, ...glow }}>@{head.handle}</div>
            {head.name !== `@${head.handle}` ? (
              <div style={{ display: "flex", fontSize: 36, color: SOFT }}>{head.name.slice(0, 40)}</div>
            ) : null}
            {head.amountUsd ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 10 }}>
                <div style={{ display: "flex", fontSize: 72, ...glow }}>${head.amountUsd} USDC</div>
                {head.note ? <div style={{ display: "flex", fontSize: 38, color: SOFT }}>for {head.note.slice(0, 32)}</div> : null}
              </div>
            ) : (
              <div style={{ display: "flex", fontSize: 34, marginTop: 10 }}>Crypto by text. No app. No wallet address.</div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", fontSize: 96, ...glow }}>Pay anyone by text</div>
            <div style={{ display: "flex", fontSize: 34, color: SOFT }}>Send, request and invoice crypto by SMS.</div>
          </div>
        )}
      </ShareFrame>
    ),
    {
      ...CARD_SIZE,
      fonts: fontsFor(font),
      headers: { "cache-control": "public, max-age=600, s-maxage=600" },
    },
  );
}

import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { enabledChainNames } from "@/lib/chain-status";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { askQuery, loadPayHeader } from "@/lib/web/pay-page";
import { CARD_SIZE, fontsFor, GREEN, INK, markDataUrl, ShareFrame, SOFT, terminalFont } from "../../../press/art";
import { running } from "../../../site";

export const dynamic = "force-dynamic";

/** Big enough to read in a chat preview, small enough that "@" and a 32-character handle still fit beside the QR. */
const handleSize = (h: string) => (h.length <= 10 ? 124 : h.length <= 16 ? 96 : h.length <= 22 ? 68 : 46);

/** The share card for /@handle: who to pay, what they asked for, and how. Unknown handles get a plain Dial card. */
export async function GET(req: Request, ctx: RouteContext<"/pay/[handle]/card">): Promise<Response> {
  const { handle } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const [head, font, mark] = await Promise.all([
    loadPayHeader(handle, { amount: q.get("amount"), note: q.get("note") }).catch(() => null),
    terminalFont(),
    markDataUrl(),
  ]);
  const { APP_URL, DIAL_OPERATOR_NUMBER } = publicEnv();
  const phone = formatPhone(DIAL_OPERATOR_NUMBER);
  // The QR opens the pay page itself (every way to pay, amount preset), not one chain's wallet link.
  // Dark modules on the bright panel: some phone cameras won't read light-on-dark codes.
  const qr = head
    ? `data:image/svg+xml;base64,${Buffer.from(
        await QRCode.toString(`${APP_URL}/@${head.handle}${askQuery(head)}`, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
          color: { dark: INK, light: GREEN },
        }),
      ).toString("base64")}`
    : null;
  const glow = { textShadow: "0 0 24px rgba(0,255,65,0.55)" };

  return new ImageResponse(
    (
      <ShareFrame
        mark={mark}
        family={font ? "Terminal" : "sans-serif"}
        tag={`TEXT ${phone}`}
        aside={["or any wallet", ...enabledChainNames(running().chains).map((n) => n.replace(/ Chain$/, ""))].join(" · ")}
      >
        {head ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 32 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 1, minWidth: 0 }}>
            <div style={{ display: "flex", fontSize: 38, color: SOFT }}>Pay</div>
            <div style={{ display: "flex", fontSize: handleSize(head.handle), letterSpacing: -2, ...glow }}>@{head.handle}</div>
            {head.name !== `@${head.handle}` ? (
              <div style={{ display: "flex", fontSize: 36, color: SOFT }}>{head.name.slice(0, 40)}</div>
            ) : null}
            {head.amountUsd ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 10 }}>
                <div style={{ display: "flex", flexShrink: 0, fontSize: 72, ...glow }}>${head.amountUsd} USDC</div>
                {head.note ? <div style={{ display: "flex", fontSize: 38, color: SOFT }}>for {head.note.slice(0, 32)}</div> : null}
              </div>
            ) : (
              <div style={{ display: "flex", fontSize: 34, marginTop: 10 }}>Crypto by text. No app. No wallet address.</div>
            )}
          </div>
          {qr ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <img src={qr} width={250} height={250} alt="" />
              <div style={{ display: "flex", fontSize: 22, color: SOFT }}>scan to pay</div>
            </div>
          ) : null}
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

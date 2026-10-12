import { ImageResponse } from "next/og";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import type { StatusTone } from "@/lib/views/payment";
import { cardAmount, loadReceiptCard } from "@/lib/web/receipt-card";
import { CARD_SIZE, fontsFor, GREEN, INK, markDataUrl, ShareFrame, SOFT, terminalFont } from "../../../press/art";

export const dynamic = "force-dynamic";

const TONE: Record<StatusTone, { color: string; background: string }> = {
  done: { color: INK, background: GREEN },
  waiting: { color: GREEN, background: "transparent" },
  bad: { color: "#ff6b6b", background: "transparent" },
};

/** Big enough to read in a chat preview; two 32-character handles still fit on one line. */
const partiesSize = (s: string) => (s.length <= 24 ? 52 : s.length <= 40 ? 40 : 30);

/**
 * The share card for /a/<id>: amount, network and status, people by @handle only. No names, notes or
 * numbers at any status, since chat apps show the preview to everyone in the thread. Unknown ids get a
 * plain Dial card.
 */
export async function GET(_req: Request, ctx: RouteContext<"/a/[intentId]/card">): Promise<Response> {
  const { intentId } = await ctx.params;
  const [view, font, mark] = await Promise.all([loadReceiptCard(intentId).catch(() => null), terminalFont(), markDataUrl()]);
  const phone = formatPhone(publicEnv().DIAL_OPERATOR_NUMBER);
  const glow = { textShadow: "0 0 24px rgba(0,255,65,0.55)" };
  const parties = view ? `${view.from} → ${view.to}` : "";
  const tone = view ? TONE[view.status.tone] : TONE.waiting;

  return new ImageResponse(
    (
      <ShareFrame
        mark={mark}
        family={font ? "Terminal" : "sans-serif"}
        tag={`TEXT ${phone}`}
        aside={view?.status.tone === "done" ? "approved by text · settled on-chain" : "every payment approved by text"}
      >
        {view ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", fontSize: 38, color: SOFT }}>
              {view.kindLabel} · {view.network}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
              <div style={{ display: "flex", fontSize: 124, letterSpacing: -2, ...glow }}>{cardAmount(view)}</div>
              <div
                style={{
                  display: "flex",
                  padding: "8px 18px",
                  fontSize: 34,
                  border: `3px solid ${tone.color === INK ? GREEN : tone.color}`,
                  color: tone.color,
                  background: tone.background,
                }}
              >
                {view.status.label}
              </div>
            </div>
            <div style={{ display: "flex", fontSize: partiesSize(parties) }}>{parties}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", fontSize: 96, ...glow }}>A Dial payment</div>
            <div style={{ display: "flex", fontSize: 34, color: SOFT }}>Send, request and invoice crypto by SMS.</div>
          </div>
        )}
      </ShareFrame>
    ),
    {
      ...CARD_SIZE,
      fonts: fontsFor(font),
      // Short, since a pending payment's status changes within minutes.
      headers: { "cache-control": "public, max-age=120, s-maxage=120" },
    },
  );
}

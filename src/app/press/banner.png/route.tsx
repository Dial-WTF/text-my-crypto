import { ImageResponse } from "next/og";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { GREEN, INK, markDataUrl, terminalFont } from "../art";

export const dynamic = "force-static";

/** Wide banner for X / GitHub / Colosseum headers: 1500×500. */
export async function GET() {
  const [font, mark] = await Promise.all([terminalFont(), markDataUrl()]);
  const phone = formatPhone(publicEnv().DIAL_OPERATOR_NUMBER);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", gap: 56, padding: "0 90px", background: INK, color: GREEN, fontFamily: font ? "Terminal" : "sans-serif" }}>
        <img src={mark} width={220} height={220} alt="" />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", fontSize: 52, color: "#8cf5a6" }}>Dial.operator by Dial.Work</div>
          <div style={{ display: "flex", fontSize: 120, letterSpacing: -2, textShadow: "0 0 28px rgba(0,255,65,0.5)" }}>{phone}</div>
          <div style={{ display: "flex", fontSize: 40 }}>Text money to anyone. No app. No wallet address.</div>
        </div>
      </div>
    ),
    { width: 1500, height: 500, fonts: font ? [{ name: "Terminal", data: font, weight: 400, style: "normal" }] : undefined },
  );
}

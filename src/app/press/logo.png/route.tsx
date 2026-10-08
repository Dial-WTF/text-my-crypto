import { ImageResponse } from "next/og";
import { GREEN, INK, markDataUrl, terminalFont } from "../art";

export const dynamic = "force-static";

/** Square product logo for submissions and profiles: 1024×1024. */
export async function GET() {
  const [font, mark] = await Promise.all([terminalFont(), markDataUrl()]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 40, background: INK, color: GREEN, fontFamily: font ? "Terminal" : "sans-serif" }}>
        <div style={{ display: "flex", width: 420, height: 420, alignItems: "center", justifyContent: "center", borderRadius: 96, border: `6px solid ${GREEN}`, boxShadow: "0 0 80px rgba(0,255,65,0.35)" }}>
          <img src={mark} width={260} height={260} alt="" />
        </div>
        <div style={{ display: "flex", fontSize: 104, letterSpacing: -2, textShadow: "0 0 30px rgba(0,255,65,0.5)" }}>Dial.operator</div>
        <div style={{ display: "flex", fontSize: 40, color: "#8cf5a6" }}>text money to anyone · by Dial.Work</div>
      </div>
    ),
    { width: 1024, height: 1024, fonts: font ? [{ name: "Terminal", data: font, weight: 400, style: "normal" }] : undefined },
  );
}

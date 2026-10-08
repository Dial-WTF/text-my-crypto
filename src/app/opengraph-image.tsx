import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { site } from "./site";

export const dynamic = "force-static";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = site().shareAlt;

const GREEN = "#00ff41";
const DIM = "#0b6b23";
const GLYPHS = "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789";

async function terminalFont(): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch("https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap", {
      headers: { "user-agent": "Mozilla/4.0" },
    }).then((r) => r.text());
    const src = /src: url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    return src ? await fetch(src).then((r) => r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Deterministic rain columns so every build renders the same card. */
function rain(): string[] {
  let seed = 7;
  const next = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  return Array.from({ length: 34 }, () =>
    Array.from({ length: 24 }, () => GLYPHS[Math.floor(next() * GLYPHS.length)]).join("\n"),
  );
}

export default async function OpenGraphImage() {
  const s = site();
  const [font, mark] = await Promise.all([
    terminalFont(),
    readFile(join(process.cwd(), "public/brand/dialwork-mark.png")),
  ]);
  const markSrc = `data:image/png;base64,${Buffer.from(mark).toString("base64")}`;
  const family = font ? "Terminal" : "sans-serif";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#030a05", fontFamily: family }}>
        <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "space-between", padding: "0 10px", opacity: 0.35 }}>
          {rain().map((col, i) => (
            <div key={i} style={{ display: "flex", whiteSpace: "pre", color: DIM, fontSize: 24, lineHeight: 1.1, marginTop: -((i * 37) % 200) }}>
              {col}
            </div>
          ))}
        </div>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", padding: "56px 64px", color: GREEN }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <img src={markSrc} width={56} height={56} alt="" />
            <div style={{ display: "flex", fontSize: 40 }}>Dial.operator</div>
            <div style={{ display: "flex", fontSize: 24, color: "#5fd37a", marginLeft: 8 }}>by Dial.Work</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", fontSize: 34, color: "#8cf5a6" }}>Text the operator</div>
            <div style={{ display: "flex", fontSize: 118, letterSpacing: -2, textShadow: "0 0 24px rgba(0,255,65,0.55)" }}>{s.phone}</div>
            <div style={{ display: "flex", fontSize: 34 }}>Send, request and invoice crypto by SMS.</div>
            <div style={{ display: "flex", fontSize: 34, color: "#8cf5a6" }}>No app. No wallet address. Any phone.</div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 24 }}>
            <div style={{ display: "flex", padding: "6px 14px", background: GREEN, color: "#030a05" }}>LIVE · USDC ON SOLANA</div>
            <div style={{ display: "flex", color: "#8cf5a6" }}>Tempo · Base · Hyperliquid · Zcash next</div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: font ? [{ name: "Terminal", data: font, weight: 400, style: "normal" }] : undefined },
  );
}

import { site } from "../site";
import { MARK_DATA_URL } from "./mark-data";

export const GREEN = "#00ff41";
export const INK = "#030a05";

export async function terminalFont(): Promise<ArrayBuffer | null> {
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

/** The Dial.Work mark as a data URL (white on transparent). Embedded, so it works at build time and in the Worker. */
export async function markDataUrl(): Promise<string> {
  return MARK_DATA_URL;
}

const DIM = "#0b6b23";
export const SOFT = "#8cf5a6";
const GLYPHS = "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789";

/** Deterministic rain columns so every card renders the same background. */
function rain(columns = 34, rows = 24): string[] {
  let seed = 7;
  const next = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  return Array.from({ length: columns }, () =>
    Array.from({ length: rows }, () => GLYPHS[Math.floor(next() * GLYPHS.length)]).join("\n"),
  );
}

export const CARD_SIZE = { width: 1200, height: 630 };

/** The share-card frame: rain backdrop, Dial.operator header, the card's own body, and a tag + line footer. */
export function ShareFrame({
  mark,
  family,
  children,
  tag,
  aside,
}: {
  mark: string;
  family: string;
  children: React.ReactNode;
  /** Footer, left: a solid tag. */
  tag: string;
  /** Footer, right: one muted line. */
  aside: string;
}) {
  const { byline } = site();
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: INK, fontFamily: family }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "space-between", padding: "0 10px", opacity: 0.35 }}>
        {rain().map((col, i) => (
          <div key={i} style={{ display: "flex", whiteSpace: "pre", color: DIM, fontSize: 24, lineHeight: 1.1, marginTop: -((i * 37) % 200) }}>
            {col}
          </div>
        ))}
      </div>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", padding: "56px 64px", color: GREEN }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={mark} width={56} height={56} alt="" />
          <div style={{ display: "flex", fontSize: 40 }}>Dial.operator</div>
          {byline ? <div style={{ display: "flex", fontSize: 24, color: "#5fd37a", marginLeft: 8 }}>{byline}</div> : null}
        </div>
        {children}
        <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", gap: 24, fontSize: 24 }}>
          <Tag>{tag}</Tag>
          <div style={{ display: "flex", color: SOFT }}>{aside}</div>
        </div>
      </div>
    </div>
  );
}

/** A solid green tag, e.g. "LIVE · USDC ON SOLANA". */
function Tag({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexShrink: 0, padding: "6px 14px", background: GREEN, color: INK }}>{children}</div>;
}

export function fontsFor(font: ArrayBuffer | null) {
  return font ? [{ name: "Terminal", data: font, weight: 400 as const, style: "normal" as const }] : undefined;
}

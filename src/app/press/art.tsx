import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** The Dial.Work mark as a data URL (white on transparent). */
export async function markDataUrl(): Promise<string> {
  const png = await readFile(join(process.cwd(), "public/brand/dialwork-mark.png"));
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

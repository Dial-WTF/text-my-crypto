import type { ThemeChoice } from "./themes";

/** Resolves "system" to light or dark before first paint, so there's no flash of the wrong theme. */
export function ThemeScript({ choice }: { choice: ThemeChoice }) {
  if (choice !== "system") return null;
  const js = `document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}

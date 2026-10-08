"use client";

import { useSyncExternalStore } from "react";
import { MatrixRain } from "./backdrops/MatrixRain";
import type { ThemeId } from "./themes";

/** Per-theme decoration behind the page. Most themes have none. */
const BACKDROPS: Partial<Record<ThemeId, () => React.JSX.Element>> = {
  matrix: MatrixRain,
};

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function useActiveTheme(): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme,
    () => undefined,
  );
}

export function ThemeBackdrop() {
  const theme = useActiveTheme();
  const Backdrop = theme ? BACKDROPS[theme as ThemeId] : undefined;
  return Backdrop ? <Backdrop /> : null;
}

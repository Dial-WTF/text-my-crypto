import { THEME_COOKIE, type ThemeChoice, type ThemeId } from "./themes";

const YEAR = 60 * 60 * 24 * 365;

export function resolveTheme(choice: ThemeChoice): ThemeId {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies a theme to the page now and remembers it for server renders. */
export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=${YEAR}; samesite=lax`;
}

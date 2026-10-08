/** The theme registry. Adding a theme = one CSS file in ./themes and one entry here. */
export const THEMES = [
  { id: "matrix", label: "Matrix" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeChoice = ThemeId | "system";

/** What a first-time visitor sees. */
export const DEFAULT_THEME: ThemeChoice = "matrix";

export const THEME_COOKIE = "dial-theme";
export const THEME_CHOICES: ReadonlyArray<{ id: ThemeChoice; label: string }> = [
  ...THEMES,
  { id: "system", label: "System" },
];

export function parseThemeChoice(value: string | undefined): ThemeChoice {
  return THEME_CHOICES.some((t) => t.id === value) ? (value as ThemeChoice) : DEFAULT_THEME;
}

/** Server-side best guess before the browser can say what it prefers. */
export function initialTheme(choice: ThemeChoice): ThemeId {
  return choice === "system" ? "dark" : choice;
}

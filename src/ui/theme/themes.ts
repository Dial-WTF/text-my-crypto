/** The theme registry. Adding a theme = one CSS file in ./themes and one entry here. */
export const THEMES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "matrix", label: "Matrix" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeChoice = ThemeId | "system";

export const THEME_COOKIE = "dial-theme";
export const THEME_CHOICES: ReadonlyArray<{ id: ThemeChoice; label: string }> = [
  { id: "system", label: "System" },
  ...THEMES,
];

export function parseThemeChoice(value: string | undefined): ThemeChoice {
  return THEME_CHOICES.some((t) => t.id === value) ? (value as ThemeChoice) : "system";
}

/** Server-side best guess before the browser can say what it prefers. */
export function initialTheme(choice: ThemeChoice): ThemeId {
  return choice === "system" ? "dark" : choice;
}

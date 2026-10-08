import { cookies } from "next/headers";
import { parseThemeChoice, THEME_COOKIE, type ThemeChoice } from "./themes";

export async function themeChoice(): Promise<ThemeChoice> {
  return parseThemeChoice((await cookies()).get(THEME_COOKIE)?.value);
}

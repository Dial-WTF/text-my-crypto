import { publicEnv } from "@/lib/env";

export const COMPANY = "Dial.Work";

/** "by Dial.Work" when SHOW_BYLINE=yes, else null: one switch for every place the site names itself. */
export function byline(): string | null {
  return publicEnv().SHOW_BYLINE === "yes" ? `by ${COMPANY}` : null;
}

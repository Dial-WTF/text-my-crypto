const MAX_NAME = 40;
const MAX_HANDLE = 19;

/**
 * Turns whatever someone texts as their name into a display name: the part before the first comma
 * or semicolon, whitespace collapsed, a leading @ dropped, capped at 40 characters on a word boundary.
 */
export function cleanDisplayName(raw: string): string | null {
  const first = raw.split(/[,;|\n]/)[0] ?? "";
  const collapsed = first
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^@/, "");
  if (!/[\p{L}\p{N}]/u.test(collapsed)) return null;
  if (collapsed.length <= MAX_NAME) return collapsed;
  const cut = collapsed.slice(0, MAX_NAME + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : collapsed.slice(0, MAX_NAME)).trim();
}

/** A payable handle derived from a display name: ASCII letters and digits only, 3–19 chars, never starting with a digit. */
export function handleFromName(name: string): string | null {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const handle = (/^[0-9]/.test(ascii) ? `d${ascii}` : ascii).slice(0, MAX_HANDLE);
  return handle.length >= 3 ? handle : null;
}

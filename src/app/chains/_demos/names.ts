/**
 * Cleans a name typed into the names demo: lowercase labels of letters, digits and hyphens, ending in one
 * of the service's suffixes (".eth", ".base.eth"). Null for anything else, so the lookup route never
 * passes odd input to a resolver.
 */
export function cleanName(raw: string, suffixes: readonly string[]): string | null {
  const name = raw.trim().toLowerCase();
  if (name.length < 3 || name.length > 64) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return null;
  if (name.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) return null;
  return suffixes.some((s) => name.endsWith(s) && name.length > s.length) ? name : null;
}

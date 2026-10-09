/** Joins CSS-module class names, skipping empty ones and any a module doesn't define (no "undefined" class). */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

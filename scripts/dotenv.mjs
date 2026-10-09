// A small dotenv reader for the deploy scripts. Values are never printed.
//
//   KEY=value              -> "value"
//   KEY=value # comment    -> "value"   (a # after whitespace starts a comment)
//   KEY=abc#def            -> "abc#def" (a # inside an unquoted value is kept)
//   KEY="a # b"            -> "a # b"   (quoted values are taken as written, then any comment after them dropped)
//   KEY="line\nnext"       -> a real newline; \" and \\ also work in double quotes
//   KEY='raw\n'            -> "raw\n"   (single quotes are literal)
//   export KEY=value       -> "value"

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r\n|\n|\r/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const value = parseValue(rest);
    // Name the key, never the value: it is probably a secret.
    if (value === null) throw new Error(`${key}: the quoted value is never closed`);
    out[key] = value;
  }
  return out;
}

/**
 * @param {string} rest everything after the `=`, leading whitespace already gone
 * @returns {string | null} null when a quoted value is never closed
 */
function parseValue(rest) {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    let value = "";
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i];
      if (c === quote) return value;
      if (quote === '"' && c === "\\" && i + 1 < rest.length) {
        const next = rest[++i];
        value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
        continue;
      }
      value += c;
    }
    return null;
  }
  return rest.replace(/(^|\s)#.*$/, "").trim();
}

// Runs after `opennextjs-cloudflare build`, before any deploy.
// OpenNext copies every value from .env, .env.local and .env.<mode>.local into
// .open-next/cloudflare/next-env.mjs, and the Worker fills in any missing variable from it. That would
// bake local secrets into the uploaded script and make a deleted Worker secret fall back silently.
// This rewrites the file to keep only public values, then fails if any secret value from a local env
// file still appears anywhere in the build output. Prints key names only, never values.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = ".open-next";
const ENV_MODULE = path.join(OUT, "cloudflare", "next-env.mjs");
const PUBLIC = new Set(["APP_URL", "DIAL_OPERATOR_NUMBER"]);
const isPublic = (key) => PUBLIC.has(key) || key.startsWith("NEXT_PUBLIC_");
// Plain configuration: still dropped from the baked file, but not secret, so not leak-checked.
const CONFIG = new Set(["PAYPHONE_BASE_URL", "SMS_MODE", "NEXTJS_ENV", "NETWORK", "CHAINS", "ESCROW_TTL_DAYS", "SIGNUP_DRIP_USD", "DIAL_OPERATOR_MODEL", "WORKERS_AI_MODEL"]);

if (!existsSync(ENV_MODULE)) {
  console.error(`scrub: ${ENV_MODULE} not found; run the OpenNext build first.`);
  process.exit(1);
}

const mod = await import(path.resolve(ENV_MODULE));
const modes = Object.keys(mod);
const dropped = new Set();
const lines = modes.map((mode) => {
  const kept = Object.fromEntries(
    Object.entries(mod[mode]).filter(([key]) => {
      if (isPublic(key)) return true;
      dropped.add(key);
      return false;
    }),
  );
  return `export const ${mode} = ${JSON.stringify(kept)};`;
});
writeFileSync(ENV_MODULE, `${lines.join("\n")}\n`);
console.log(`scrub: kept public values only; dropped ${dropped.size ? [...dropped].sort().join(", ") : "nothing"}`);

// Every non-public value in any local env file is treated as a secret that must not ship.
function parse(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const secrets = new Map();
for (const file of readdirSync(".").filter((f) => f.startsWith(".env") || f === ".dev.vars")) {
  for (const [key, value] of Object.entries(parse(readFileSync(file, "utf8")))) {
    if (!isPublic(key) && !CONFIG.has(key) && value.length >= 12) secrets.set(value, key);
  }
}

const leaks = new Set();
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) scan(p);
    else if (s.size < 50_000_000) {
      const text = readFileSync(p, "latin1");
      for (const [value, key] of secrets) if (text.includes(value)) leaks.add(`${key} in ${path.relative(OUT, p)}`);
    }
  }
}
scan(OUT);
if (leaks.size) {
  console.error(`scrub: secret values still in the build:\n  ${[...leaks].join("\n  ")}`);
  process.exit(1);
}
console.log(`scrub: checked ${secrets.size} secret values; none in ${OUT}`);

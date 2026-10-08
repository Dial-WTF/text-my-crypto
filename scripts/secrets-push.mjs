// Pushes production secrets from .env.production.local to the Worker in one request.
// The file is the source of truth: Worker secrets are write-only, so keep it (and a backup) safe.
// Only allowlisted names and RPC_* overrides go up, blank values are skipped, values are never
// printed, and nothing is ever deleted. Usage: pnpm secrets:push [--dry-run]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE = ".env.production.local";
const SECRETS = new Set([
  "PAYPHONE_API_KEY",
  "SMS_WEBHOOK_SECRET",
  "WALLET_ENCRYPTION_KEY",
  "SOLANA_TREASURY_SEED",
  "EVM_TREASURY_KEY",
  "TEMPO_TREASURY_KEY",
  "ALCHEMY_API_KEY",
  "AI_GATEWAY_API_KEY",
]);
const isSecret = (key) => SECRETS.has(key) || /^RPC_[A-Z0-9_]+$/.test(key);

function parse(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const all = parse(readFileSync(FILE, "utf8"));
const secrets = Object.fromEntries(Object.entries(all).filter(([k, v]) => isSecret(k) && v !== ""));
const skipped = Object.keys(all).filter((k) => !(k in secrets));

console.log(`Pushing ${Object.keys(secrets).length} secrets: ${Object.keys(secrets).join(", ")}`);
if (skipped.length) console.log(`Not pushed (not a secret, or blank): ${skipped.join(", ")}`);
if (process.argv.includes("--dry-run")) process.exit(0);

const res = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk"], {
  input: JSON.stringify(secrets),
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(res.status ?? 1);

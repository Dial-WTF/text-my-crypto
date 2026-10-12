// Send stablecoin from the operator treasury to a Dial handle.
// Reads SOLANA_TREASURY_SEED (and chain treasury keys) from ENV_FILE or .env.production.local.
// Usage: ENV_FILE=.env.production.local npx tsx scripts/treasury-send.mjs <handle> <usd> [chain]
// Example: npx tsx scripts/treasury-send.mjs jpmeyer 5 solana

process.loadEnvFile(process.env.ENV_FILE ?? ".env.production.local");

// Wrangler supplies these at runtime; for local scripts default to production values if absent.
process.env.DIAL_OPERATOR_NUMBER ??= "+18066071387";
process.env.NETWORK ??= "testnet";
process.env.CHAINS ??= "solana,tempo";
process.env.ESCROW_PROGRAM ??= "on";
process.env.ESCROW_TTL_DAYS ??= "7";
process.env.SMS_MODE ??= "log";
process.env.SIGNUP_DRIP_USD ??= "2";
process.env.PER_TX_CAP_USD ??= "50";
process.env.PER_DAY_CAP_USD ??= "200";
process.env.PASSKEY_THRESHOLD_USD ??= "20";

import { env } from "../src/lib/env.ts";
import { getAdapters } from "../src/lib/settlement/index.ts";
import { usdToBaseUnits } from "../src/lib/money.ts";

const [handle, usd, chainName = "solana"] = process.argv.slice(2);

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!handle) stop("usage: treasury-send.mjs <handle> <usd> [chain]");
if (!usd || !/^\d+(\.\d{1,2})?$/.test(usd) || Number(usd) <= 0) stop(`bad amount: ${usd}`);

const appUrl = env().APP_URL.replace(/\/$/, "");

const profileRes = await fetch(`${appUrl}/api/pay/${encodeURIComponent(handle.replace(/^@/, ""))}?amount=${usd}`);
if (!profileRes.ok) stop(`handle lookup failed: ${profileRes.status} ${await profileRes.text()}`);
const profile = await profileRes.json();

const chain = profile.chains.find((c) => c.chain === chainName);
if (!chain) stop(`${chainName} not available for @${profile.handle}. chains: ${profile.chains.map((c) => c.chain).join(", ")}`);

const adapters = getAdapters();
const adapter = adapters[chainName];
if (!adapter) stop(`adapter not built for ${chainName}. check CHAINS and treasury keys.`);

const treasury = await adapter.treasuryAddress();
const before = await adapter.getBalance(chain.address);
console.log(`Treasury on ${chain.network}: ${treasury}`);
console.log(`Recipient @${profile.handle}: ${chain.address}`);
console.log(`Recipient current balance: $${(Number(before) / 1e6).toFixed(2)} ${chain.asset}`);
console.log(`Sending $${usd} ${chain.asset} on ${chain.network} to @${profile.handle}...`);

const result = await adapter.fund(chain.address, usdToBaseUnits(usd));
console.log("explorer:", result.explorerUrl);
console.log("tx:", result.txHash);

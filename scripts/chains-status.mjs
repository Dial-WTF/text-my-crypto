// Is each chain's treasury ready to fund signups and pay fees? Reads .env.production.local (or ENV_FILE),
// checks every registry entry on NETWORK (default testnet), and never prints a key or a keyed RPC URL.
// Usage: pnpm chains:status
import { createKeyPairSignerFromPrivateKeyBytes, createSolanaRpc, address as solAddress } from "@solana/kit";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REGISTRY, resolveRpc } from "../src/lib/settlement/registry.ts";
import { errorText } from "../src/lib/settlement/redact.ts";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.production.local");
const env = process.env;
const network = env.NETWORK ?? "testnet";
const drip = Number(env.SIGNUP_DRIP_USD ?? "2");
const enabled = new Set((env.CHAINS ?? "solana,tempo").split(",").map((s) => s.trim()));
const overrides = Object.fromEntries(Object.entries(env).filter(([k, v]) => /^RPC_[A-Z0-9_]+$/.test(k) && v));
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function solana(entry, rpcUrl) {
  if (!env.SOLANA_TREASURY_SEED) return { missing: "SOLANA_TREASURY_SEED" };
  const signer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(Buffer.from(env.SOLANA_TREASURY_SEED, "base64")));
  const rpc = createSolanaRpc(rpcUrl);
  const lamports = (await rpc.getBalance(signer.address).send()).value;
  const accounts = await rpc
    .getTokenAccountsByOwner(signer.address, { mint: solAddress(entry.mint) }, { encoding: "jsonParsed" })
    .send();
  const usd = accounts.value.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmountString ?? 0), 0);
  return { treasury: signer.address, gas: `${(Number(lamports) / 1e9).toFixed(3)} SOL`, gasOk: lamports > 10_000_000n, usd };
}

async function evmLike(entry, rpcUrl, key, nativeGas) {
  if (!key) return { missing: entry.kind === "tempo" ? "TEMPO_TREASURY_KEY" : "EVM_TREASURY_KEY" };
  const treasury = privateKeyToAccount(key).address;
  const client = createPublicClient({ chain: entry.viem, transport: http(rpcUrl) });
  const usd = entry.token
    ? Number(formatUnits(await client.readContract({ address: entry.token, abi: erc20, functionName: "balanceOf", args: [treasury] }), 6))
    : null;
  if (!nativeGas) return { treasury, gas: "fees paid in stablecoin", gasOk: true, usd };
  const wei = await client.getBalance({ address: treasury });
  return { treasury, gas: `${Number(formatUnits(wei, 18)).toFixed(4)} ${entry.viem.nativeCurrency.symbol}`, gasOk: wei > 0n, usd };
}

const rows = [];
for (const [chain, byNetwork] of Object.entries(REGISTRY)) {
  const entry = byNetwork[network];
  if (!entry) {
    rows.push({ chain, network: "—", status: "not built" });
    continue;
  }
  const rpc = resolveRpc(entry, { alchemyKey: env.ALCHEMY_API_KEY || undefined, overrides });
  const via = `${rpc.source} (${new URL(rpc.url).host})`;
  try {
    const r =
      entry.kind === "solana"
        ? await solana(entry, rpc.url)
        : await evmLike(entry, rpc.url, entry.kind === "tempo" ? env.TEMPO_TREASURY_KEY : env.EVM_TREASURY_KEY, entry.kind === "evm");
    if (r.missing) {
      rows.push({ chain, network: entry.network, via, status: `no ${r.missing}` });
      continue;
    }
    const tokenNote = r.usd === null ? "no stablecoin" : `$${r.usd}${entry.faucet ? " (faucet refills)" : ""}`;
    // A testnet faucet entry (Tempo Moderato) refills the treasury on demand, so an empty balance is fine.
    const ready = r.gasOk && r.usd !== null && (r.usd >= drip || entry.faucet === true);
    const status = ready ? (enabled.has(chain) ? "LIVE" : "ready, not in CHAINS") : r.usd === null ? "needs a stablecoin" : "needs funding";
    rows.push({ chain, network: entry.network, via, treasury: r.treasury, gas: r.gas, stablecoin: tokenNote, status });
  } catch (e) {
    rows.push({ chain, network: entry.network, via, status: `error: ${errorText(e).slice(0, 90)}` });
  }
}

console.log(`NETWORK=${network}  CHAINS=${[...enabled].join(",")}  drip=$${drip}\n`);
console.table(rows);

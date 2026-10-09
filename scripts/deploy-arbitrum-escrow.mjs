// Deploys and activates dial_escrow (contracts/arbitrum-escrow) on Arbitrum Sepolia with this deployment's
// attestor fixed in it, and prints the contract address. Production and staging each get their own contract,
// since a contract only takes claims from the attestor it was deployed with.
//
//   ARBITRUM_DEPLOYER_KEY=0x… pnpm escrow:deploy:arbitrum [--env staging] [--dry-run] [--rpc <url>]
//
// The deployer key comes from the shell, never a file in the repo; it only pays for the deploy. The attestor
// is EVM_ESCROW_ATTESTOR_KEY in .env.production.local (or .env.<env>.local, or ENV_FILE); only its address is
// used here. --dry-run builds, checks activation against the chain, and estimates gas, without sending.
// Keys and keyed RPC URLs are never printed. Needs cargo-stylus 0.10.10 (cargo install --locked cargo-stylus).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REGISTRY, resolveRpc } from "../src/lib/settlement/registry.ts";
import { parseDotenv } from "./dotenv.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const stop = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const ENV = arg("--env") ?? "production";
if (!/^[a-z]+$/.test(ENV)) stop("usage: pnpm escrow:deploy:arbitrum [--env <name>] [--dry-run] [--rpc <url>]");
const DRY = process.argv.includes("--dry-run");
const FILE = process.env.ENV_FILE ?? (ENV === "production" ? ".env.production.local" : `.env.${ENV}.local`);
const CRATE = "contracts/arbitrum-escrow";
const entry = REGISTRY.arbitrum.testnet;

let file;
try {
  file = parseDotenv(readFileSync(FILE, "utf8"));
} catch {
  stop(`Can't read ${FILE}.`);
}
const attestorKey = file.EVM_ESCROW_ATTESTOR_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(attestorKey ?? "")) {
  stop(`EVM_ESCROW_ATTESTOR_KEY is not set in ${FILE}. Make one (each deployment its own) with:\n  node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"`);
}
const attestor = privateKeyToAccount(attestorKey).address;

const overrides = Object.fromEntries(Object.entries(file).filter(([k, v]) => /^RPC_[A-Z0-9_]+$/.test(k) && v));
const rpcUrl = arg("--rpc") ?? resolveRpc(entry, { alchemyKey: file.ALCHEMY_API_KEY, overrides }).url;
const client = createPublicClient({ transport: http(rpcUrl) });
const chainId = await client.getChainId();
if (!arg("--rpc") && chainId !== entry.viem.id) stop(`The RPC is on chain ${chainId}, not ${entry.network} (${entry.viem.id}).`);
console.log(`${ENV}: deploying to chain ${chainId}${arg("--rpc") ? "" : ` (${entry.network})`} with attestor ${attestor}`);

// The Security Council paused activations on 2 Oct 2026 by setting the activation gas to 2^64 - 1.
const arbWasm = parseAbi(["function activationGas() view returns (uint64)"]);
const activationGas = await client
  .readContract({ address: "0x0000000000000000000000000000000000000071", abi: arbWasm, functionName: "activationGas" })
  .catch(() => 0n);
if (activationGas > 30_000_000n) {
  stop(`Stylus activations are paused on this chain (ArbWasm.activationGas() = ${activationGas}). Nothing was deployed.`, 2);
}

const deployerKey = process.env.ARBITRUM_DEPLOYER_KEY;
if (deployerKey && !/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) stop("ARBITRUM_DEPLOYER_KEY must be a 0x-prefixed 32-byte hex key.");
if (!deployerKey && !DRY) stop("Set ARBITRUM_DEPLOYER_KEY in the shell (an Arbitrum Sepolia key with about 0.01 ETH). It is never written to disk in the repo.");

const run = (args) => {
  const r = spawnSync("cargo", ["stylus", ...args], { cwd: CRATE, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
};

const check = run(["check", "--endpoint", rpcUrl]);
if (!check.ok) stop(`cargo stylus check failed:\n${check.out.replaceAll(rpcUrl, "<rpc>")}`);
console.log(check.out.match(/contract size: .*|wasm data fee: .*/g)?.join("\n") ?? "cargo stylus check passed");
if (!deployerKey) {
  console.log("Dry run without ARBITRUM_DEPLOYER_KEY: built and checked; set it to estimate the deploy's gas.");
  process.exit(0);
}

const deployer = privateKeyToAccount(deployerKey).address;
console.log(`deployer ${deployer}: ${formatEther(await client.getBalance({ address: deployer }))} ETH`);

// cargo-stylus takes the key from a file; it lives in a private temp dir for the length of the run.
const dir = mkdtempSync(join(tmpdir(), "dial-deploy-"));
const keyFile = join(dir, "key");
writeFileSync(keyFile, deployerKey, { mode: 0o600 });
let deploy;
try {
  // --constructor-args takes every value after it, so it goes last.
  const flags = ["deploy", "--endpoint", rpcUrl, "--private-key-path", keyFile, "--no-verify", ...(DRY ? ["--estimate-gas"] : [])];
  deploy = run([...flags, "--constructor-args", attestor]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const out = deploy.out.replaceAll(rpcUrl, "<rpc>");
if (!deploy.ok) stop(`cargo stylus deploy failed:\n${out}`);
if (DRY) {
  console.log(out.match(/.*(gas|ETH).*/gi)?.join("\n") ?? out);
  process.exit(0);
}

// cargo-stylus colours its output; strip the escapes before looking for the address.
const address = out.replace(/\x1b\[[0-9;]*m/g, "").match(/deployed code at address:?\s*(0x[0-9a-fA-F]{40})/i)?.[1];
if (!address) stop(`Deployed, but couldn't find the address in cargo-stylus's output:\n${out}`);
const escrowAbi = parseAbi(["function attestor() view returns (address)"]);
const fixed = await client.readContract({ address, abi: escrowAbi, functionName: "attestor" });
if (fixed !== attestor) stop(`The contract at ${address} names attestor ${fixed}, not ${attestor}.`);

console.log(`\ndial_escrow deployed and activated at ${address} (attestor ${attestor}).`);
console.log(
  ENV === "production"
    ? `Next: set escrowContract: "${address}" on arbitrum.testnet in src/lib/settlement/registry.ts.`
    : `Next: set "ESCROW_CONTRACT_ARBITRUM_SEPOLIA": "${address}" in the ${ENV} vars in wrangler.jsonc.`,
);
console.log(`Then EVM_ESCROW_ATTESTOR_KEY goes up with pnpm secrets:push${ENV === "production" ? "" : ` --env ${ENV}`}.`);

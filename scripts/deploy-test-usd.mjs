// Deploys Dial Test USD (contracts/src/DialTestUSD.sol) to a testnet that has no Circle test USDC,
// then mints test dollars to the EVM treasury. Reads EVM_TREASURY_KEY from .env.production.local.
// Usage: pnpm contracts:deploy [chain=robinhood] [mintUsd=1000]
// Afterwards put the printed address in that chain's testnet `token` in src/lib/settlement/registry.ts.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorText } from "../src/lib/settlement/redact.ts";
import { REGISTRY, resolveRpc } from "../src/lib/settlement/registry.ts";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.production.local");
const [chain = "robinhood", mintUsd = "1000"] = process.argv.slice(2);
const entry = REGISTRY[chain]?.testnet;

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!entry || entry.kind !== "evm") stop(`${chain} has no EVM testnet entry in the registry.`);
if (entry.token) stop(`${entry.network} already settles in ${entry.token}; nothing to deploy.`);
if (!process.env.EVM_TREASURY_KEY) stop("EVM_TREASURY_KEY is not set.");

const treasury = privateKeyToAccount(process.env.EVM_TREASURY_KEY);
const rpc = resolveRpc(entry, {
  alchemyKey: process.env.ALCHEMY_API_KEY || undefined,
  overrides: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith("RPC_") && v)),
});
const transport = http(rpc.url);
const pub = createPublicClient({ chain: entry.viem, transport });
const wallet = createWalletClient({ chain: entry.viem, transport, account: treasury });
const artifact = JSON.parse(readFileSync("contracts/artifacts/DialTestUSD.json", "utf8"));

try {
  const gas = await pub.getBalance({ address: treasury.address });
  if (gas === 0n) {
    stop(`The treasury ${treasury.address} has no ${entry.viem.nativeCurrency.symbol} on ${entry.network}. Fund it for gas, then run this again.`);
  }
  console.log(`Deploying Dial Test USD to ${entry.network} from ${treasury.address} (${formatUnits(gas, 18)} ${entry.viem.nativeCurrency.symbol})…`);
  const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
  const deployed = await pub.waitForTransactionReceipt({ hash: deployHash });
  if (deployed.status !== "success" || !deployed.contractAddress) stop(`Deploy reverted: ${entry.explorerTx(deployHash)}`);
  const token = deployed.contractAddress;

  const amount = BigInt(Math.round(Number(mintUsd) * 1_000_000));
  const mintHash = await wallet.writeContract({ address: token, abi: artifact.abi, functionName: "mint", args: [treasury.address, amount] });
  const minted = await pub.waitForTransactionReceipt({ hash: mintHash });
  if (minted.status !== "success") stop(`Mint reverted: ${entry.explorerTx(mintHash)}`);

  console.log(`\nDial Test USD on ${entry.network}: ${token}`);
  console.log(`  contract: ${entry.explorerAddress(token)}`);
  console.log(`  minted $${mintUsd} to the treasury: ${entry.explorerTx(mintHash)}`);
  console.log(`\nNext: set token: "${token}" on REGISTRY.${chain}.testnet in src/lib/settlement/registry.ts.`);
} catch (e) {
  stop(`Failed: ${errorText(e)}`);
}

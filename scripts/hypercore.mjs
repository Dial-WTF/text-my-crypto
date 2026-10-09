// HyperEVM -> HyperCore deposits (contracts/src/DialCoreDeposit.sol). Reads EVM_TREASURY_KEY from
// .env.production.local (or ENV_FILE), never prints it, and works on NETWORK (default testnet).
//
//   pnpm hypercore status          treasury gas, USDC, HyperCore spot balance, deposit contract
//   pnpm hypercore deploy          deploys DialCoreDeposit; put the address in the registry's venue.depositContract
//   pnpm hypercore deposit [usd]   one real deposit: the treasury's own USDC into its own HyperCore spot balance
//                                  (default $1), through the deployed contract, then reads HyperCore until it lands
//
// DEPOSIT_CONTRACT overrides the registry address (to try a fresh deploy before committing it).
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  hexToBigInt,
  http,
  keccak256,
  parseAbi,
  parseSignature,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorText } from "../src/lib/settlement/redact.ts";
import { REGISTRY, resolveRpc } from "../src/lib/settlement/registry.ts";

process.loadEnvFile(process.env.ENV_FILE ?? ".env.production.local");
const network = process.env.NETWORK ?? "testnet";
const [command = "status", usdArg = "1"] = process.argv.slice(2);
const entry = REGISTRY.hyperevm[network];

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!entry?.token || !entry.venue) stop(`HyperEVM ${network} has no USDC or HyperCore entry in the registry.`);
if (!process.env.EVM_TREASURY_KEY) stop("EVM_TREASURY_KEY is not set.");
const core = entry.venue;
const usdc = entry.token;
const treasury = privateKeyToAccount(process.env.EVM_TREASURY_KEY);
const rpc = resolveRpc(entry, {
  alchemyKey: process.env.ALCHEMY_API_KEY || undefined,
  overrides: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith("RPC_") && v)),
});
const transport = http(rpc.url);
const pub = createPublicClient({ chain: entry.viem, transport });
const wallet = createWalletClient({ chain: entry.viem, transport, account: treasury });
const artifact = JSON.parse(readFileSync("contracts/artifacts/DialCoreDeposit.json", "utf8"));
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function name() view returns (string)", "function version() view returns (string)"]);
const depositContract = process.env.DEPOSIT_CONTRACT || core.depositContract;

async function coreUsdc(user) {
  const res = await fetch(core.infoUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "spotClearinghouseState", user }),
  });
  if (!res.ok) throw new Error(`info API answered ${res.status}`);
  const usdcRow = (await res.json()).balances?.find((b) => b.token === 0);
  return usdcRow ? usdcRow.total : "0";
}

/** HyperEVM's coreUserExists precompile: HyperCore only credits deposits to accounts it already has. */
async function onHyperCore(user) {
  const { data } = await pub.call({ to: "0x0000000000000000000000000000000000000810", data: encodeAbiParameters([{ type: "address" }], [user]) });
  return Boolean(data && data !== "0x" && hexToBigInt(data) !== 0n);
}

async function status() {
  const [gas, usd, spot] = await Promise.all([
    pub.getBalance({ address: treasury.address }),
    pub.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [treasury.address] }),
    coreUsdc(treasury.address),
  ]);
  console.log(`${entry.network} via ${rpc.source} (${new URL(rpc.url).host})`);
  console.log(`  treasury           ${treasury.address} (${entry.explorerAddress(treasury.address)})`);
  console.log(`  gas                ${formatUnits(gas, 18)} ${entry.viem.nativeCurrency.symbol}`);
  console.log(`  USDC on HyperEVM   $${formatUnits(usd, 6)}`);
  console.log(`  USDC on ${core.network}  $${spot} (${core.explorerAddress(treasury.address)})`);
  console.log(`  ${core.network} account ${(await onHyperCore(treasury.address)) ? "open" : "not open: deposits to it are never credited"}`);
  console.log(`  CoreDepositWallet  ${core.coreDepositWallet}`);
  console.log(`  DialCoreDeposit    ${depositContract ?? "not deployed (pnpm hypercore deploy)"}`);
  return { gas, usd };
}

async function deploy() {
  const { gas } = await status();
  if (gas === 0n) stop(`\nThe treasury has no ${entry.viem.nativeCurrency.symbol} for gas on ${entry.network}. Fund it, then run this again.`);
  console.log(`\nDeploying DialCoreDeposit(USDC ${usdc}, CoreDepositWallet ${core.coreDepositWallet})…`);
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [usdc, core.coreDepositWallet] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) stop(`Deploy reverted: ${entry.explorerTx(hash)}`);
  console.log(`DialCoreDeposit on ${entry.network}: ${receipt.contractAddress}`);
  console.log(`  deploy: ${entry.explorerTx(hash)}`);
  console.log(`\nNext: set venue.depositContract: "${receipt.contractAddress}" on REGISTRY.hyperevm.${network} in src/lib/settlement/registry.ts.`);
}

async function deposit() {
  if (!depositContract) stop("No DialCoreDeposit address: run pnpm hypercore deploy first, or set DEPOSIT_CONTRACT.");
  if (!/^\d+(\.\d{1,6})?$/.test(usdArg) || Number(usdArg) <= 0) stop(`usd must be a positive dollar amount like 1 or 2.50, not "${usdArg}".`);
  const [whole, frac = ""] = usdArg.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  const { gas, usd } = await status();
  if (gas === 0n) stop(`\nThe treasury has no ${entry.viem.nativeCurrency.symbol} for gas.`);
  if (usd < amount) stop(`\nThe treasury has $${formatUnits(usd, 6)} USDC on ${entry.network}, less than $${usdArg}.`);

  if (!(await onHyperCore(treasury.address))) {
    stop(`\nThe treasury has no ${core.network} account, and HyperCore keeps deposits to accounts it hasn't seen. Open it first: send it USDC on ${core.network}.`);
  }
  const before = await coreUsdc(treasury.address);
  const memo = `hypercore-live-${Date.now()}`;
  const nonce = keccak256(stringToHex(memo));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const [name, version] = await Promise.all([
    pub.readContract({ address: usdc, abi: erc20, functionName: "name" }),
    pub.readContract({ address: usdc, abi: erc20, functionName: "version" }),
  ]);
  const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
  const types = ["address", "address", "uint256", "uint256", "uint256", "bytes32"];
  const signature = await treasury.signTypedData({
    domain: { name, version, chainId: entry.viem.id, verifyingContract: usdc },
    types: { ReceiveWithAuthorization: fields.map((n, i) => ({ name: n, type: types[i] })) },
    primaryType: "ReceiveWithAuthorization",
    message: { from: treasury.address, to: depositContract, value: amount, validAfter: 0n, validBefore, nonce },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  console.log(`\nDepositing $${usdArg} into the treasury's ${core.network} spot balance (it had $${before})…`);
  const hash = await wallet.writeContract({
    address: depositContract,
    abi: artifact.abi,
    functionName: "deposit",
    args: [treasury.address, treasury.address, amount, validBefore, nonce, Number(v ?? BigInt(yParity + 27)), r, s],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") stop(`Deposit reverted: ${entry.explorerTx(hash)}`);
  console.log(`  HyperEVM tx: ${entry.explorerTx(hash)}`);

  for (let i = 0; i < 30; i++) {
    const now = await coreUsdc(treasury.address);
    if (now !== before) {
      console.log(`  ${core.network} spot USDC: $${before} -> $${now} (${core.explorerAddress(treasury.address)})`);
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  console.log(`  ${core.network} hasn't shown it after a minute. Check ${core.explorerAddress(treasury.address)}`);
}

try {
  if (command === "status") await status();
  else if (command === "deploy") await deploy();
  else if (command === "deposit") await deposit();
  else stop(`Unknown command "${command}". Use status, deploy or deposit.`);
} catch (e) {
  stop(`Failed: ${errorText(e)}`);
}

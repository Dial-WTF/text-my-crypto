import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperliquidEvmTestnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizationNonce, createEvmAdapter } from "@/lib/settlement/evm";
import { REGISTRY } from "@/lib/settlement/registry";

// Proves DialCoreDeposit against Circle's real USDC and CoreDepositWallet, on a local fork of HyperEVM testnet:
// the user signs, the treasury submits, the USDC leaves the user's wallet into CoreDepositWallet.depositFor in
// one transaction. HyperCore itself isn't forked, so the credit there is checked live, not here.
// Needs Foundry's anvil and the network: HYPERCORE_FORK=1 pnpm vitest run tests/settlement/hypercore.fork.test.ts
const run = process.env.HYPERCORE_FORK === "1";
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's first well-known dev account, funded on the fork. Local chain only.
const TREASURY_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const entry = REGISTRY.hyperevm.testnet;
if (entry?.kind !== "evm" || !entry.token || !entry.venue) throw new Error("registry has no HyperEVM testnet USDC");
const USDC = entry.token;
const CDW = entry.venue.coreDepositWallet;
// FiatToken v2.2 keeps balances in `balanceAndBlacklistStates`, storage slot 9: the fork's test user gets USDC there.
const BALANCE_SLOT = 9n;
const artifact = JSON.parse(readFileSync("contracts/artifacts/DialCoreDeposit.json", "utf8")) as { abi: Abi; bytecode: Hex };
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

let anvil: ChildProcess | undefined;
let contract: Address;
const pub = createPublicClient({ chain: hyperliquidEvmTestnet, transport: http(RPC) });

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil did not start");
}

describe.runIf(run)("DialCoreDeposit on a HyperEVM testnet fork (anvil)", () => {
  beforeAll(async () => {
    anvil = spawn(process.env.ANVIL ?? `${homedir()}/.foundry/bin/anvil`, [
      "--port",
      String(PORT),
      "--fork-url",
      entry.publicRpc,
      "--silent",
    ]);
    await waitForRpc();
    const treasury = createWalletClient({ chain: hyperliquidEvmTestnet, transport: http(RPC), account: privateKeyToAccount(TREASURY_KEY) });
    const hash = await treasury.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [USDC, CDW] });
    contract = (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("moves a user's signed USDC into CoreDepositWallet.depositFor for the recipient, once", { timeout: 120_000 }, async () => {
    const adapter = createEvmAdapter({
      chain: "hyperevm",
      viem: hyperliquidEvmTestnet,
      token: USDC,
      explorerTx: (h) => `local/${h}`,
      treasuryKey: TREASURY_KEY,
      rpcUrl: RPC,
      venue: { ...entry.venue!, depositContract: contract },
    });
    expect(adapter.venue?.name).toBe("HyperCore");
    const user = await adapter.createWallet();
    const recipient = await adapter.createWallet();

    const test = createTestClient({ chain: hyperliquidEvmTestnet, mode: "anvil", transport: http(RPC) });
    await test.setStorageAt({
      address: USDC,
      index: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user.address as Address, BALANCE_SLOT])),
      value: pad(toHex(3_000_000n)),
    });
    expect(await adapter.getBalance(user.address)).toBe(3_000_000n);

    // The user holds no gas: the treasury submits their signed authorization.
    const res = await adapter.venue!.deposit({ fromSecret: user.secret, to: recipient.address, amount: 2_000_000n, memo: "pi_forktest00001" });
    expect(res.explorerUrl).toBe(`local/${res.txHash}`);
    expect(await adapter.getBalance(user.address)).toBe(1_000_000n);
    expect(await adapter.getBalance(contract)).toBe(0n);

    const receipt = await pub.getTransactionReceipt({ hash: res.txHash as Hex });
    const moves = parseEventLogs({ abi: erc20, logs: receipt.logs, eventName: "Transfer" }).filter(
      (l) => getAddress(l.address) === getAddress(USDC),
    );
    // USDC goes user → DialCoreDeposit → CoreDepositWallet (which credits the recipient on HyperCore).
    expect(moves.map((l) => [getAddress(l.args.from), getAddress(l.args.to), l.args.value])).toEqual([
      [getAddress(user.address), getAddress(contract), 2_000_000n],
      [getAddress(contract), getAddress(CDW), 2_000_000n],
    ]);
    const deposited = parseEventLogs({ abi: artifact.abi, logs: receipt.logs, eventName: "CoreDeposit" });
    expect(deposited).toHaveLength(1);
    expect(deposited[0]?.args).toMatchObject({
      from: getAddress(user.address),
      recipient: getAddress(recipient.address),
      amount: 2_000_000n,
      nonce: authorizationNonce("pi_forktest00001"),
    });
    expect(
      await pub.readContract({
        address: USDC,
        abi: erc20,
        functionName: "authorizationState",
        args: [user.address as Address, authorizationNonce("pi_forktest00001")],
      }),
    ).toBe(true);

    // The nonce is the payment id: the same payment can never move twice.
    await expect(
      adapter.venue!.deposit({ fromSecret: user.secret, to: recipient.address, amount: 1_000_000n, memo: "pi_forktest00001" }),
    ).rejects.toThrow();
    expect(await adapter.getBalance(user.address)).toBe(1_000_000n);
  });

  it("only the operator can submit, so nobody can redirect a signed deposit", { timeout: 60_000 }, async () => {
    const stranger = createWalletClient({
      chain: hyperliquidEvmTestnet,
      transport: http(RPC),
      // anvil's second dev account.
      account: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
    });
    await expect(
      stranger.writeContract({
        address: contract,
        abi: artifact.abi,
        functionName: "deposit",
        args: [stranger.account.address, stranger.account.address, 1n, 0n, `0x${"00".repeat(32)}`, 27, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`],
      }),
    ).rejects.toThrow(/only operator/);
  });
});

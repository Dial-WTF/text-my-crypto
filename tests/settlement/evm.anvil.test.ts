import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { type Abi, type Address, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizationNonce, createEvmAdapter } from "@/lib/settlement/evm";

// Proves the EVM adapter settles on our own EIP-3009 test dollar (contracts/src/DialTestUSD.sol), the token
// we deploy where Circle has no test USDC. Needs Foundry's anvil: ANVIL_INT=1 pnpm vitest run tests/settlement/evm.anvil.test.ts
const run = process.env.ANVIL_INT === "1";
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's first well-known dev account. Local chain only.
const TREASURY_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const artifact = JSON.parse(readFileSync("contracts/artifacts/DialTestUSD.json", "utf8")) as { abi: Abi; bytecode: Hex };

let anvil: ChildProcess | undefined;
let token: Address;

async function waitForRpc(): Promise<void> {
  const client = createPublicClient({ chain: foundry, transport: http(RPC) });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil did not start");
}

describe.runIf(run)("evm adapter on DialTestUSD (anvil)", () => {
  beforeAll(async () => {
    anvil = spawn(process.env.ANVIL ?? `${homedir()}/.foundry/bin/anvil`, ["--port", String(PORT), "--silent"]);
    await waitForRpc();
    const treasury = privateKeyToAccount(TREASURY_KEY);
    const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: treasury });
    const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
    const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    const receipt = await pub.waitForTransactionReceipt({ hash: deployHash });
    token = receipt.contractAddress as Address;
    const mint = await wallet.writeContract({
      address: token,
      abi: artifact.abi,
      functionName: "mint",
      args: [treasury.address, 100_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash: mint });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("funds a wallet, settles a signed transfer the treasury submits, and refuses a replay", { timeout: 60_000 }, async () => {
    const adapter = createEvmAdapter({
      chain: "robinhood",
      viem: foundry,
      token,
      explorerTx: (h) => `local/${h}`,
      treasuryKey: TREASURY_KEY,
      rpcUrl: RPC,
    });
    const a = await adapter.createWallet();
    const b = await adapter.createWallet();

    await adapter.fund(a.address, 5_000_000n);
    expect(await adapter.getBalance(a.address)).toBe(5_000_000n);

    // `a` holds no gas at all: the treasury submits its signed authorization.
    const res = await adapter.settle({ fromSecret: a.secret, to: b.address, amount: 2_000_000n, memo: "pi_anviltest0001" });
    expect(res.explorerUrl).toBe(`local/${res.txHash}`);
    expect(await adapter.getBalance(a.address)).toBe(3_000_000n);
    expect(await adapter.getBalance(b.address)).toBe(2_000_000n);

    const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
    const used = await pub.readContract({
      address: token,
      abi: artifact.abi,
      functionName: "authorizationState",
      args: [a.address, authorizationNonce("pi_anviltest0001")],
    });
    expect(used).toBe(true);

    // The nonce is the payment id, so the same payment can never move twice.
    await expect(
      adapter.settle({ fromSecret: a.secret, to: b.address, amount: 1_000_000n, memo: "pi_anviltest0001" }),
    ).rejects.toThrow();
    expect(await adapter.getBalance(a.address)).toBe(3_000_000n);
  });
});

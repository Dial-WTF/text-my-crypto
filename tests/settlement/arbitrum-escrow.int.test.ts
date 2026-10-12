import { type Address, bytesToHex, createPublicClient, createWalletClient, defineChain, type Hex, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { createEvmEscrow, ESCROW_ABI, viemEscrowRpc } from "@/lib/settlement/evm-escrow";
import type { EscrowProgram } from "@/lib/settlement/types";

// One fund/claim and one fund/refund through the deployed dial_escrow contract, with fresh test wallets and
// the app's own escrow client. Opt-in: ESCROW_INT=1 with
//   ESCROW_RPC            the chain (default: a local `nitro-node --dev` on 8547)
//   ESCROW_CONTRACT       the contract, deployed with pnpm escrow:deploy:arbitrum
//   ESCROW_TREASURY_KEY   pays gas and holds the contract's dollar (Circle USDC on Arbitrum Sepolia; on a dev
//                         node, the EscrowTestUSD that scripts/nitro-devnode.sh deploys and mints)
//   ESCROW_ATTESTOR_KEY   the attestor the contract was deployed with
// The dollar is the one the contract was deployed with, read from its token(). It prints the transaction hashes. Test wallets only, never real numbers or real money.
const run = process.env.ESCROW_INT === "1";
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)", "function name() view returns (string)", "function version() view returns (string)"]);
const AMOUNT = 100_000n; // $0.10

describe.runIf(run)("dial_escrow on a real chain", () => {
  let escrow: EscrowProgram;
  let balanceOf: (a: Address) => Promise<bigint>;
  let fundSender: (to: Address) => Promise<void>;
  let newBlock: () => Promise<void>;
  const hashes: Record<string, string> = {};

  beforeAll(async () => {
    const rpcUrl = process.env.ESCROW_RPC ?? "http://127.0.0.1:8547";
    const probe = createPublicClient({ transport: http(rpcUrl) });
    const chainId = await probe.getChainId();
    const viem = chainId === arbitrumSepolia.id ? arbitrumSepolia : defineChain({ id: chainId, name: "Nitro dev", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const transport = http(rpcUrl);
    const pub = createPublicClient({ chain: viem, transport });
    const treasuryKey = env("ESCROW_TREASURY_KEY") as Hex;
    const treasury = createWalletClient({ chain: viem, transport, account: privateKeyToAccount(treasuryKey) });

    const contract = env("ESCROW_CONTRACT") as Address;
    const tokenAddress = await pub.readContract({ address: contract, abi: ESCROW_ABI, functionName: "token" });
    const explorer = chainId === arbitrumSepolia.id ? (h: string) => `https://sepolia.arbiscan.io/tx/${h}` : (h: string) => h;
    escrow = createEvmEscrow({
      contract,
      token: tokenAddress,
      chainId,
      explorerTx: explorer,
      rpc: viemEscrowRpc({
        viem,
        rpcUrl,
        contract,
        treasuryKey,
        attestorKey: env("ESCROW_ATTESTOR_KEY") as Hex,
        token: tokenAddress,
        tokenDomain: async () => ({
          name: await pub.readContract({ address: tokenAddress, abi: erc20, functionName: "name" }),
          version: await pub.readContract({ address: tokenAddress, abi: erc20, functionName: "version" }),
        }),
      }),
    });
    balanceOf = (a) => pub.readContract({ address: tokenAddress, abi: erc20, functionName: "balanceOf", args: [a] });
    fundSender = async (to) => {
      await pub.waitForTransactionReceipt({ hash: await treasury.writeContract({ address: tokenAddress, abi: erc20, functionName: "transfer", args: [to, AMOUNT] }) });
    };
    // An idle dev node makes no blocks, and calls are simulated on the latest one: a self-transfer makes a fresh block.
    newBlock = async () => {
      await pub.waitForTransactionReceipt({ hash: await treasury.sendTransaction({ to: treasury.account.address, value: 0n }) });
    };
  }, 120_000);

  const wallet = () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    return { secret, address: privateKeyToAccount(bytesToHex(secret)).address };
  };

  it("funds, then the attestor claims it to the recipient", { timeout: 180_000 }, async () => {
    const sender = wallet();
    const recipient = wallet();
    await fundSender(sender.address);
    const intentId = `pi_int_claim_${Date.now()}`;

    const funded = await escrow.create({ fromSecret: sender.secret, intentId, amount: AMOUNT, expiresAt: new Date(Date.now() + 3_600_000) });
    hashes.fundForClaim = funded.txHash;
    expect(await balanceOf(sender.address)).toBe(0n);
    expect(await escrow.lookup(intentId)).toMatchObject({ state: "open", sender: sender.address, amount: AMOUNT, funded });

    const claimed = await escrow.claim({ intentId, to: recipient.address });
    hashes.claim = claimed.txHash;
    expect(await balanceOf(recipient.address)).toBe(AMOUNT);
    expect(await escrow.lookup(intentId)).toEqual({ state: "claimed", result: claimed });
    // A second claim is the same claim.
    expect(await escrow.claim({ intentId, to: recipient.address })).toEqual(claimed);
  });

  it("funds, refuses an early refund, then refunds to the sender after expiry", { timeout: 180_000 }, async () => {
    const sender = wallet();
    await fundSender(sender.address);
    const intentId = `pi_int_refund_${Date.now()}`;
    // Wall clock, not the latest block: a dev node only makes blocks when transactions come in.
    const expirySeconds = Math.floor(Date.now() / 1000) + 20;

    const funded = await escrow.create({ fromSecret: sender.secret, intentId, amount: AMOUNT, expiresAt: new Date(expirySeconds * 1000) });
    hashes.fundForRefund = funded.txHash;
    await expect(escrow.refund({ intentId, senderSecret: sender.secret })).rejects.toThrow("NotExpired");

    while (Date.now() / 1000 < expirySeconds + 3) await new Promise((r) => setTimeout(r, 1_000));
    await newBlock();
    const refunded = await escrow.refund({ intentId, senderSecret: sender.secret });
    hashes.refund = refunded.txHash;
    expect(await balanceOf(sender.address)).toBe(AMOUNT);
    expect(await escrow.lookup(intentId)).toEqual({ state: "refunded", result: refunded });
    console.log("dial_escrow round-trip transactions:", hashes);
  });
});

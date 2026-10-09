import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { createEvmAdapter } from "@/lib/settlement/evm";
import { type EvmNetwork, REGISTRY, resolveRpc } from "@/lib/settlement/registry";

// Live check of one EVM testnet with the real treasury: a 1-cent drop, then a gasless signed transfer back.
// set -a; . ./.env.production.local; set +a; EVM_INT=1 EVM_INT_CHAIN=robinhood pnpm vitest run tests/settlement/evm.int.test.ts --silent=false
const run = process.env.EVM_INT === "1";
const chain = (process.env.EVM_INT_CHAIN ?? "base") as "base" | "ethereum" | "arbitrum" | "hyperevm" | "robinhood";

describe.runIf(run)(`evm adapter (${chain} testnet, live)`, () => {
  it("drops a cent to a fresh wallet and settles it back with only a signature", { timeout: 180_000 }, async () => {
    const entry = REGISTRY[chain].testnet as EvmNetwork;
    const rpc = resolveRpc(entry, {
      alchemyKey: process.env.ALCHEMY_API_KEY || undefined,
      overrides: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith("RPC_") && v)),
    });
    const adapter = createEvmAdapter({ ...entry, chain, rpcUrl: rpc.url, treasuryKey: process.env.EVM_TREASURY_KEY as Hex });
    const treasury = await adapter.treasuryAddress();
    const wallet = await adapter.createWallet();

    const drop = await adapter.fund(wallet.address, 10_000n);
    expect(await adapter.getBalance(wallet.address)).toBe(10_000n);

    const res = await adapter.settle({ fromSecret: wallet.secret, to: treasury, amount: 10_000n, memo: `pi_int${Date.now()}` });
    expect(res.explorerUrl).toContain(res.txHash);
    expect(await adapter.getBalance(wallet.address)).toBe(0n);
    console.info(`${entry.network} drop ${drop.explorerUrl}\n${entry.network} signed transfer back ${res.explorerUrl}`);
  });
});

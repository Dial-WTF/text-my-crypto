import { describe, expect, it } from "vitest";
import { b64ToBytes } from "@/lib/secretbox";
import { createSolanaAdapter } from "@/lib/settlement/solana";

const run = process.env.SOLANA_INT === "1";

describe.runIf(run)("solana adapter (devnet)", () => {
  it("funds a new wallet, then settles a transfer with a memo", { timeout: 120_000 }, async () => {
    const adapter = createSolanaAdapter({
      rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
      mint: process.env.SOLANA_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      treasurySeed: b64ToBytes(process.env.SOLANA_TREASURY_SEED ?? ""),
    });
    const a = await adapter.createWallet();
    const b = await adapter.createWallet();
    await adapter.fund(a.address, 2_000_000n);
    expect(await adapter.getBalance(a.address)).toBe(2_000_000n);

    const res = await adapter.settle({ fromSecret: a.secret, to: b.address, amount: 1_000_000n, memo: "pi_test" });
    expect(res.explorerUrl).toContain(res.txHash);
    expect(await adapter.getBalance(b.address)).toBe(1_000_000n);
  });
});

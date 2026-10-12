import { describe, expect, it } from "vitest";
import { b64ToBytes } from "@/lib/secretbox";
import { REGISTRY, type SolanaNetwork } from "@/lib/settlement/registry";
import { createSolanaAdapter } from "@/lib/settlement/solana";
import { EscrowExpiredError } from "@/lib/settlement/types";

const run = process.env.SOLANA_INT === "1";
const devnet = REGISTRY.solana.testnet as SolanaNetwork;

describe.runIf(run)("solana adapter (devnet)", () => {
  it("funds a new wallet, then settles a transfer with a memo", { timeout: 120_000 }, async () => {
    const adapter = createSolanaAdapter({
      rpcUrl: process.env.RPC_SOLANA_DEVNET ?? devnet.publicRpc,
      mint: devnet.mint,
      explorerTx: devnet.explorerTx,
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

describe.runIf(run)("solana escrow (devnet)", () => {
  it("funds an escrow, releases it and closes the escrow token account", { timeout: 120_000 }, async () => {
    const adapter = createSolanaAdapter({
      rpcUrl: process.env.RPC_SOLANA_DEVNET ?? devnet.publicRpc,
      mint: devnet.mint,
      explorerTx: devnet.explorerTx,
      treasurySeed: b64ToBytes(process.env.SOLANA_TREASURY_SEED ?? ""),
    });
    const escrow = await adapter.createWallet();
    const recipient = await adapter.createWallet();
    await adapter.fund(escrow.address, 1_000_000n);
    await adapter.settle({ fromSecret: escrow.secret, to: recipient.address, amount: 1_000_000n, memo: "pi_escrow", closeSource: true });
    expect(await adapter.getBalance(recipient.address)).toBe(1_000_000n);
    expect(await adapter.getBalance(escrow.address)).toBe(0n);
  });
});

const attestorSeed = process.env.SOLANA_ESCROW_ATTESTOR_SEED;

describe.runIf(run && attestorSeed)("solana escrow program (devnet)", () => {
  const adapter = () =>
    createSolanaAdapter({
      rpcUrl: process.env.RPC_SOLANA_DEVNET ?? devnet.publicRpc,
      mint: devnet.mint,
      explorerTx: devnet.explorerTx,
      treasurySeed: b64ToBytes(process.env.SOLANA_TREASURY_SEED ?? ""),
      escrow: { programId: devnet.escrowProgram ?? "", attestorSeed: b64ToBytes(attestorSeed ?? "") },
    });

  it("escrows, claims with the attestor, and a repeated claim returns the same transaction", { timeout: 180_000 }, async () => {
    const a = adapter();
    const escrow = a.escrow!;
    const sender = await a.createWallet();
    const recipient = await a.createWallet();
    await a.fund(sender.address, 1_000_000n);
    const intentId = `pi_int_${Date.now()}`;

    await escrow.create({ fromSecret: sender.secret, intentId, amount: 1_000_000n, expiresAt: new Date(Date.now() + 3_600_000) });
    expect(await a.getBalance(sender.address)).toBe(0n);

    const claimed = await escrow.claim({ intentId, to: recipient.address });
    expect(await a.getBalance(recipient.address)).toBe(1_000_000n);
    expect(await escrow.claim({ intentId, to: recipient.address })).toEqual(claimed);
    await expect(escrow.refund({ intentId })).rejects.toThrow(/already claimed/);
  });

  it("refuses a late claim as expired, then refunds to the sender", { timeout: 240_000 }, async () => {
    const a = adapter();
    const escrow = a.escrow!;
    const sender = await a.createWallet();
    await a.fund(sender.address, 1_000_000n);
    const intentId = `pi_int_${Date.now()}`;

    await escrow.create({ fromSecret: sender.secret, intentId, amount: 1_000_000n, expiresAt: new Date(Date.now() + 30_000) });
    await expect(escrow.refund({ intentId })).rejects.toThrow(/NotExpired/);

    await new Promise((r) => setTimeout(r, 45_000));
    const recipient = await a.createWallet();
    await expect(escrow.claim({ intentId, to: recipient.address })).rejects.toBeInstanceOf(EscrowExpiredError);

    let refunded: Awaited<ReturnType<typeof escrow.refund>> | null = null;
    for (let i = 0; i < 20 && !refunded; i++) {
      await new Promise((r) => setTimeout(r, 6_000));
      refunded = await escrow.refund({ intentId }).catch(() => null);
    }
    expect(refunded).not.toBeNull();
    expect(await a.getBalance(sender.address)).toBe(1_000_000n);
    expect(await escrow.refund({ intentId })).toEqual(refunded);
  });
});

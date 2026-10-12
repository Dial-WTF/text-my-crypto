import { describe, expect, it } from "vitest";
import { usdToBaseUnits } from "@/lib/money";
import { REGISTRY } from "@/lib/settlement/registry";
import { createZcashAdapter } from "@/lib/settlement/zcash";

// A real round-trip on Zcash testnet through a running wallet service with a funded treasury.
// ZCASH_INT=1 ZCASH_SERVICE_URL=http://localhost:8787 ZCASH_SERVICE_TOKEN=… pnpm vitest run tests/settlement/zcash.int.test.ts
// Takes several testnet blocks (~75s each). Spends about 0.03 TAZ of the treasury per run.
const run = process.env.ZCASH_INT === "1";

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 600_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

describe.runIf(run)("zcash adapter (testnet, live service)", () => {
  it("drips, pays with a memo, and sweeps an escrow back out", { timeout: 1_800_000 }, async () => {
    const entry = REGISTRY.zcash.testnet;
    if (entry?.kind !== "zcash" || entry.usdPerZec === null) throw new Error("no zcash testnet entry");
    const adapter = createZcashAdapter({
      serviceUrl: process.env.ZCASH_SERVICE_URL ?? "http://localhost:8787",
      token: process.env.ZCASH_SERVICE_TOKEN ?? "",
      usdPerZec: entry.usdPerZec,
      asset: entry.asset,
      addressPrefix: entry.addressPrefix,
      explorerTx: entry.explorerTx,
    });
    console.log(`treasury: ${await adapter.treasuryAddress()}`);
    const alice = await adapter.createWallet();
    const escrow = await adapter.createWallet();
    const bob = await adapter.createWallet();
    const dollar = usdToBaseUnits("1");

    const drip = await adapter.fund(alice.address, dollar);
    console.log(`drip: ${drip.explorerUrl ?? drip.txHash}`);
    await until("the drip", () => adapter.getBalance(alice.address), (b) => b >= dollar);

    // Into escrow: two fees on top, one for the release and one for the recipient's next send.
    const paid = await adapter.settle({ fromSecret: alice.secret, to: escrow.address, amount: dollar, memo: "pi_zcash_int", escrow: true });
    console.log(`pay: ${paid.explorerUrl ?? paid.txHash}`);
    // Asking again with the same payment id returns the same transaction instead of paying twice.
    const again = await adapter.settle({ fromSecret: alice.secret, to: escrow.address, amount: dollar, memo: "pi_zcash_int", escrow: true });
    expect(again.txHash).toBe(paid.txHash);
    await until("the escrow", () => adapter.getBalance(escrow.address), (b) => b >= dollar);

    // Out of escrow: the sweep pays its own fee and bob can send the full dollar.
    const released = await adapter.settle({ fromSecret: escrow.secret, to: bob.address, amount: dollar, memo: "pi_zcash_int", closeSource: true });
    console.log(`release: ${released.explorerUrl ?? released.txHash}`);
    await until("the release", () => adapter.getBalance(bob.address), (b) => b >= dollar);
    expect(await adapter.getBalance(escrow.address)).toBe(0n);
  });
});

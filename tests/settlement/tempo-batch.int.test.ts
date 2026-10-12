import { type Hex, hexToString, parseEventLogs } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Abis, Account, createClient, http } from "viem/tempo";
import { describe, expect, it } from "vitest";
import { ALPHA_USD, batchCalls, createTempoAdapter } from "@/lib/settlement/tempo";

const run = process.env.TEMPO_INT === "1";
const rpcUrl = process.env.RPC_TEMPO_MODERATO ?? "https://rpc.moderato.tempo.xyz";

/** Throwaway wallets only: a fresh treasury tops itself up from the Moderato faucet. */
describe.runIf(run)("tempo batched split (moderato)", () => {
  const treasuryKey = generatePrivateKey();
  const adapter = createTempoAdapter({ treasuryKey, rpcUrl, faucet: true });
  const client = createClient({ chain: tempoModerato, feeToken: ALPHA_USD, transport: http(rpcUrl) });

  it("pays three people in one sponsored transaction, one memo per leg", { timeout: 240_000 }, async () => {
    const payer = await adapter.createWallet();
    const people = await Promise.all([adapter.createWallet(), adapter.createWallet(), adapter.createWallet()]);
    console.log(`fund: ${(await adapter.fund(payer.address, 10_000_000n)).txHash}`);

    const legs = [
      { to: people[0].address, amount: 3_340_000n, memo: "pi_split_leg_a" },
      { to: people[1].address, amount: 3_330_000n, memo: "pi_split_leg_b" },
      { to: people[2].address, amount: 3_330_000n, memo: "pi_split_leg_c" },
    ];
    const res = await adapter.batch!.settleBatch({ fromSecret: payer.secret, legs });
    console.log(`split: ${res.explorerUrl ?? res.txHash}`);

    // The treasury paid the fee: the payer is drained to exactly zero and each person got their share.
    expect(await adapter.getBalance(payer.address)).toBe(0n);
    for (const [i, leg] of legs.entries()) expect(await adapter.getBalance(people[i]!.address)).toBe(leg.amount);

    const receipt = await client.getTransactionReceipt({ hash: res.txHash as Hex });
    const memos = parseEventLogs({ abi: Abis.tip20, eventName: "TransferWithMemo", logs: receipt.logs }).map((l) =>
      hexToString(l.args.memo, { size: 32 }),
    );
    expect(memos).toEqual(legs.map((l) => l.memo));
  });

  it("lands nothing when one leg can't be paid: the whole transaction reverts", { timeout: 240_000 }, async () => {
    const payer = await adapter.createWallet();
    const [a, b] = await Promise.all([adapter.createWallet(), adapter.createWallet()]);
    await adapter.fund(payer.address, 2_000_000n);

    // The second leg asks for more than is left after the first. Gas is set by hand so the transaction is
    // mined (and reverts on-chain) instead of being refused at estimation.
    const legs = [
      { to: a.address, amount: 1_500_000n, memo: "pi_split_ok" },
      { to: b.address, amount: 1_500_000n, memo: "pi_split_short" },
    ];
    const sender = Account.fromSecp256k1(`0x${Buffer.from(payer.secret).toString("hex")}`);
    const treasury = Account.fromSecp256k1(treasuryKey);
    const receipt = await client.sendTransactionSync({
      account: sender,
      feePayer: treasury,
      calls: batchCalls(ALPHA_USD, legs),
      gas: 1_000_000n,
      throwOnReceiptRevert: false,
    });
    console.log(`reverted split: https://explore.testnet.tempo.xyz/tx/${receipt.transactionHash}`);
    expect(receipt.status).toBe("reverted");
    expect(await adapter.getBalance(a.address)).toBe(0n);
    expect(await adapter.getBalance(payer.address)).toBe(2_000_000n);

    // Through the adapter the same batch never leaves: estimation refuses it, and nothing moves.
    await expect(adapter.batch!.settleBatch({ fromSecret: payer.secret, legs })).rejects.toThrow();
    expect(await adapter.getBalance(a.address)).toBe(0n);
  });
});

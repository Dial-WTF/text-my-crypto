import { type Hex, hexToString, parseEventLogs } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Abis, createClient, http } from "viem/tempo";
import { describe, expect, it } from "vitest";
import { createTempoAdapter } from "@/lib/settlement/tempo";

const run = process.env.TEMPO_INT === "1";
const rpcUrl = process.env.RPC_TEMPO_MODERATO ?? "https://rpc.moderato.tempo.xyz";

describe.runIf(run)("tempo adapter (moderato)", () => {
  it("funds a new wallet, then settles a sponsored transfer with a memo", { timeout: 180_000 }, async () => {
    // A throwaway treasury works on testnet: the adapter tops it up from the faucet.
    const adapter = createTempoAdapter({
      treasuryKey: (process.env.TEMPO_TREASURY_KEY as Hex | undefined) ?? generatePrivateKey(),
      rpcUrl,
      faucet: true,
    });
    const a = await adapter.createWallet();
    const b = await adapter.createWallet();

    const funded = await adapter.fund(a.address, 2_000_000n);
    console.log(`fund: ${funded.explorerUrl}`);
    expect(await adapter.getBalance(a.address)).toBe(2_000_000n);

    const res = await adapter.settle({ fromSecret: a.secret, to: b.address, amount: 2_000_000n, memo: "pi_tempo_int" });
    console.log(`settle: ${res.explorerUrl}`);
    expect(res.explorerUrl).toContain(res.txHash);
    // The treasury paid the fee, so the sender is drained to exactly zero and the recipient gets it all.
    expect(await adapter.getBalance(b.address)).toBe(2_000_000n);
    expect(await adapter.getBalance(a.address)).toBe(0n);

    const client = createClient({ chain: tempoModerato, transport: http(rpcUrl) });
    const receipt = await client.getTransactionReceipt({ hash: res.txHash as Hex });
    const [memoLog] = parseEventLogs({ abi: Abis.tip20, eventName: "TransferWithMemo", logs: receipt.logs });
    expect(memoLog && hexToString(memoLog.args.memo, { size: 32 })).toBe("pi_tempo_int");
  });
});

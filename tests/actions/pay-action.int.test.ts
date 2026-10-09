import { eq } from "drizzle-orm";
import {
  createKeyPairFromPrivateKeyBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransaction,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { newReference } from "@/lib/actions/pay";
import { recordActionPayments } from "@/lib/actions/record";
import type { BotDeps } from "@/lib/bot/types";
import { actionPayments } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { b64ToBytes } from "@/lib/secretbox";
import { REGISTRY, type SolanaNetwork } from "@/lib/settlement/registry";
import { createSolanaActions } from "@/lib/settlement/solana-actions";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, smsSink, testDeps } from "../helpers/fakes";

// The real routes against Solana devnet: GET, POST, simulate the returned transaction, then pay $0.01
// from the treasury and let the reference matcher record it. Needs SOLANA_INT=1 and SOLANA_TREASURY_SEED.
const run = process.env.SOLANA_INT === "1" && !!process.env.SOLANA_TREASURY_SEED;
const devnet = REGISTRY.solana.testnet as SolanaNetwork;
const rpcUrl = process.env.RPC_SOLANA_DEVNET ?? devnet.publicRpc;
const state: { deps?: BotDeps } = {};
vi.mock("@/lib/deps", () => ({ botDeps: () => state.deps }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(run)("pay action (devnet)", () => {
  it("serves the action, builds a transaction that simulates, and records the payment once", { timeout: 180_000 }, async () => {
    const { GET, POST } = await import("@/app/api/actions/pay/[handle]/route");
    const seed = b64ToBytes(process.env.SOLANA_TREASURY_SEED ?? "");
    const payer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const db = await createTestDb();
    await createUser(db, { phone: "+15550000777", handle: "blinktest", name: null }, new Date());
    const recipient = newReference();
    const sms = smsSink();
    state.deps = testDeps(db, {
      sendSms: sms.sendSms,
      now: () => new Date(),
      adapters: {
        solana: {
          ...fakeAdapter({ defaultBalance: 100_000_000n }),
          createWallet: async () => ({ address: recipient, secret: new Uint8Array(32) }),
          actions: createSolanaActions({ rpcUrl, mint: devnet.mint, caip2: devnet.caip2, explorerTx: devnet.explorerTx }),
        },
      },
    });
    const ctx = { params: Promise.resolve({ handle: "blinktest" }) };

    const get = await GET(new Request("https://tmc.test/api/actions/pay/blinktest"), ctx);
    expect(get.status).toBe(200);
    expect(get.headers.get("x-blockchain-ids")).toBe(devnet.caip2);
    console.log("GET", JSON.stringify(await get.json()));

    const post = await POST(
      new Request("https://tmc.test/api/actions/pay/blinktest?amount=0.01", { method: "POST", body: JSON.stringify({ account: payer.address }) }),
      ctx,
    );
    const body = await post.json<{ transaction: string; message: string }>();
    expect(post.status, JSON.stringify(body)).toBe(200);
    console.log("POST message:", body.message);

    const rpc = createSolanaRpc(rpcUrl);
    const sim = await rpc
      .simulateTransaction(body.transaction as never, { encoding: "base64", sigVerify: false, commitment: "confirmed" })
      .send();
    console.log("simulate err:", JSON.stringify(sim.value.err), "units:", String(sim.value.unitsConsumed));
    console.log((sim.value.logs ?? []).join("\n"));
    expect(sim.value.err).toBeNull();
    // Create-ATA, then the transfer as a top-level token program call (devnet's token program logs no
    // instruction name), then the memo with the payment id.
    const logs = sim.value.logs?.join("\n") ?? "";
    expect(logs).toMatch(/Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success/);
    expect(logs).toMatch(/Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke \[1\]\n.*\nProgram TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success/);
    expect(logs).toMatch(/Program log: ap_/);

    // Sign as the payer's wallet would, and send.
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(body.transaction));
    const signed = await signTransaction([await createKeyPairFromPrivateKeyBytes(seed)], tx);
    const signature = getSignatureFromTransaction(signed);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
    console.log("sent:", devnet.explorerTx(signature));
    for (let i = 0; i < 60; i++) {
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
      await sleep(1000);
    }

    // getSignaturesForAddress can trail confirmation by a moment.
    let report = await recordActionPayments(state.deps);
    for (let i = 0; i < 10 && report.recorded === 0; i++) {
      await sleep(2000);
      report = await recordActionPayments(state.deps);
    }
    expect(report.recorded).toBe(1);
    expect((await recordActionPayments(state.deps)).recorded).toBe(0);
    const [row] = await db.select().from(actionPayments).where(eq(actionPayments.recipientAddress, recipient));
    expect(row).toMatchObject({ signature, received: 10_000n, payerAddress: payer.address });
    expect(sms.to("+15550000777")).toHaveLength(1);
    console.log("receipt:", sms.last("+15550000777"));
  });
});

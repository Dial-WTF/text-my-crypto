import { getDb } from "@/lib/db/client";
import { stateLabel, timeAgo } from "@/lib/payment-labels";
import { REGISTRY } from "@/lib/settlement/registry";
import { recentEscrows } from "@/lib/stats";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { liveExplorer } from "../../chain-content";
import { quietly } from "../../ledger-data";
import styles from "./demos.module.css";
import type { DemoProps } from "./types";

/** The escrow life cycle, said once for every escrow program. */
export const ESCROW_STEPS = [
  {
    title: "Sender funds the vault",
    body: "The payment moves into a vault the program owns, at an address derived from the payment id.",
  },
  {
    title: "Recipient claims on attestation",
    body: "Before expiry, the attestor key signs the claim once the recipient replies with the code texted to their phone.",
  },
  {
    title: "Refund after expiry",
    body: "From expiry on, anyone can send the refund, and the money can only go back to the sender.",
  },
] as const;

/** escrow: the program, the three steps, and the newest escrows with their transactions on the explorer. */
export async function EscrowDemo({ chain, network, adapter }: DemoProps) {
  const entry = REGISTRY[chain][network];
  const programId = adapter?.escrow?.programId ?? (entry?.kind === "solana" ? entry.escrowProgram : undefined);
  if (!entry || !programId) return null;
  const rows = await quietly("escrow activity unavailable", () => recentEscrows(getDb(), chain, 5), null);
  const now = new Date();

  return (
    <Stack gap="md">
      <ol className={styles.steps} aria-label="How the escrow works">
        {ESCROW_STEPS.map((s) => (
          <li key={s.title} className={styles.step}>
            <p className={styles.stepTitle}>{s.title}</p>
            <p className={styles.stepBody}>{s.body}</p>
          </li>
        ))}
      </ol>
      <Receipt title="Escrow program · on-chain">
        <ReceiptLine label="Program">
          <Mono value={programId} href={liveExplorer(entry.explorerAddress(programId))} />
        </ReceiptLine>
        <ReceiptRule />
        {rows === null ? (
          <Fine>The ledger can&apos;t be read right now.</Fine>
        ) : rows.length === 0 ? (
          <Fine>No payment has gone through the escrow program yet.</Fine>
        ) : (
          rows.map((r) => (
            <Stack key={r.id} gap="2xs">
              <ReceiptLine label={`${timeAgo(r.at, now)} · ${stateLabel(r.status, null, now)}`}>
                <Mono value={r.id} />
              </ReceiptLine>
              {r.funded ? (
                <ReceiptLine label="funded">
                  <Mono value={r.funded.txHash} href={liveExplorer(r.funded.explorerUrl)} />
                </ReceiptLine>
              ) : null}
              {r.closed ? (
                <ReceiptLine label={r.status === "refunded" ? "refunded" : "claimed"}>
                  <Mono value={r.closed.txHash} href={liveExplorer(r.closed.explorerUrl)} />
                </ReceiptLine>
              ) : null}
            </Stack>
          ))
        )}
        <ReceiptRule />
        <Fine>The program&apos;s explorer page lists every escrow it has opened, claimed and refunded.</Fine>
      </Receipt>
    </Stack>
  );
}

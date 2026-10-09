import { Fragment } from "react";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import styles from "./OnchainProof.module.css";

export type ProofRow = { network: string; treasury: string; treasuryUrl: string | null; escrowProgram?: { address: string; url: string | null } };

/** The public addresses behind the ledger, each linked to its explorer, so nobody has to take our word for it. */
export function OnchainProof({ rows, note, more }: { rows: ProofRow[]; note: string; more?: { href: string; label: string } }) {
  if (rows.length === 0) return null;
  return (
    <Receipt title="Check it on-chain">
      {rows.map((r) => (
        <Fragment key={r.network}>
          <ReceiptLine label={`${r.network} treasury`}>
            <Mono value={r.treasury} href={r.treasuryUrl} />
          </ReceiptLine>
          {r.escrowProgram ? (
            <ReceiptLine label={`${r.network} escrow program`}>
              <Mono value={r.escrowProgram.address} href={r.escrowProgram.url} />
            </ReceiptLine>
          ) : null}
        </Fragment>
      ))}
      <p className={styles.note}>{note}</p>
      {more ? (
        <a className={styles.more} href={more.href}>
          {more.label}
        </a>
      ) : null}
    </Receipt>
  );
}

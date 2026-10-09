import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import styles from "./OnchainProof.module.css";

export type ProofRow = { network: string; treasury: string; treasuryUrl: string };

/** The public addresses behind the ledger, each linked to its explorer, so nobody has to take our word for it. */
export function OnchainProof({ rows, note, more }: { rows: ProofRow[]; note: string; more?: { href: string; label: string } }) {
  if (rows.length === 0) return null;
  return (
    <Receipt title="Check it on-chain">
      {rows.map((r) => (
        <ReceiptLine key={r.network} label={`${r.network} treasury`}>
          <Mono value={r.treasury} href={r.treasuryUrl} />
        </ReceiptLine>
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

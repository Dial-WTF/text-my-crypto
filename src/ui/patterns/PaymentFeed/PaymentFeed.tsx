import { Money } from "@/ui/primitives/Money/Money";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import styles from "./PaymentFeed.module.css";

export type FeedEntry = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  network: string;
  state: string;
  txHash: string | null;
  explorerUrl: string | null;
};

/** Recent on-chain payments, printed as one long receipt. Handles and payment ids only, never numbers. */
export function PaymentFeed({ entries, emptyText }: { entries: FeedEntry[]; emptyText: string }) {
  return (
    <Receipt title="Live · recent payments">
      {entries.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        entries.map((e) => (
          <div key={e.id} className={styles.item}>
            <ReceiptLine label={`${e.from} → ${e.to}`}>
              <Money amount={e.amount} unit={null} />
            </ReceiptLine>
            <div className={styles.meta}>
              <span>{e.network}</span>
              <span>{e.state}</span>
              <Mono value={e.id} full />
              {e.txHash ? <Mono value={e.txHash} href={e.explorerUrl} /> : null}
            </div>
          </div>
        ))
      )}
    </Receipt>
  );
}

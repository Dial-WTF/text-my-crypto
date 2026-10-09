import { Money } from "@/ui/primitives/Money/Money";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import styles from "./PaymentFeed.module.css";

export type FeedEntry = {
  id: string;
  from: string;
  to: string;
  /** Null for a private (shielded) send. */
  amount: bigint | null;
  /** The stock token's ticker when the payment moved one, else dollars. */
  stock?: string | null;
  network: string;
  state: string;
  txHash: string | null;
  explorerUrl: string | null;
  /** "2h ago". */
  when?: string;
  /** A split: each person it paid and their share, settled together in the one transaction. */
  legs?: Array<{ to: string; amount: bigint }>;
  /** Something the viewer can do about this payment now, e.g. approve it. */
  action?: { href: string; label: string };
};

/** Recent on-chain payments, printed as one long receipt. Handles and payment ids only, never numbers. */
export function PaymentFeed({
  entries,
  emptyText,
  title = "Live · recent payments",
}: {
  entries: FeedEntry[];
  emptyText: string;
  title?: string;
}) {
  return (
    <Receipt title={title}>
      {entries.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        entries.map((e) => (
          <div key={e.id} className={styles.item}>
            <ReceiptLine label={e.legs ? `${e.from} split ${e.legs.length} ways` : `${e.from} → ${e.to}`}>
              {e.amount === null ? "shielded" : <Money amount={e.amount} unit={null} stock={e.stock ?? null} />}
            </ReceiptLine>
            {e.legs?.map((leg, i) => (
              <div key={`${e.id}-${i}`} className={styles.leg}>
                <ReceiptLine label={`→ ${leg.to}`}>
                  <Money amount={leg.amount} unit={null} />
                </ReceiptLine>
              </div>
            ))}
            <div className={styles.meta}>
              {e.when ? <span>{e.when}</span> : null}
              <span className={styles.state}>{e.state}</span>
              <span>{e.network}</span>
              <Mono value={e.id} />
              {e.txHash ? <Mono value={e.txHash} href={e.explorerUrl} /> : null}
            </div>
            {e.action ? (
              <a className={styles.action} href={e.action.href}>
                {e.action.label}
              </a>
            ) : null}
          </div>
        ))
      )}
    </Receipt>
  );
}

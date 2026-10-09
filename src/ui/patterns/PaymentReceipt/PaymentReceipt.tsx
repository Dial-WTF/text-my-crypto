import type { ReactNode } from "react";
import type { PaymentView } from "@/lib/views/payment";
import { Money } from "@/ui/primitives/Money/Money";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stamp } from "@/ui/primitives/Stamp/Stamp";
import styles from "./PaymentReceipt.module.css";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** The single source of truth for what a payment is, printed as a receipt. Actions slot in below. */
export function PaymentReceipt({ view, children }: { view: PaymentView; children?: ReactNode }) {
  return (
    <Receipt title={`Dial operator · ${view.kindLabel}`} printing={view.justSettled}>
      <div className={styles.head}>
        <span className={styles.kind}>{view.id}</span>
        <Stamp label={view.status.label} tone={view.status.tone} />
      </div>
      <ReceiptRule />
      <ReceiptLine label="From">{view.from}</ReceiptLine>
      <ReceiptLine label="To">{view.to}</ReceiptLine>
      {view.note ? <ReceiptLine label="For">{view.note}</ReceiptLine> : null}
      <ReceiptLine label="Network">{view.network}</ReceiptLine>
      {view.deadline ? <ReceiptLine label={view.deadline.label}>{when.format(view.deadline.at)} UTC</ReceiptLine> : null}
      {view.funding ? (
        <ReceiptLine label="Tx">
          <Mono value={view.funding.hash} href={view.funding.url} />
        </ReceiptLine>
      ) : null}
      {view.release ? (
        <ReceiptLine label="Released">
          <Mono value={view.release.hash} href={view.release.url} />
        </ReceiptLine>
      ) : null}
      {view.split ? (
        <>
          <ReceiptRule />
          {view.split.legs.map((leg) => (
            <ReceiptLine key={leg.id} label={leg.id === view.id ? `${leg.to} (this one)` : leg.to}>
              <Money amount={leg.amount} />
            </ReceiptLine>
          ))}
        </>
      ) : null}
      <ReceiptRule />
      <ReceiptLine label={view.split ? "Split total" : "Total"} total>
        <Money amount={view.amount} stock={view.stock} />
      </ReceiptLine>
      {children ? (
        <>
          <ReceiptRule />
          {children}
        </>
      ) : null}
    </Receipt>
  );
}

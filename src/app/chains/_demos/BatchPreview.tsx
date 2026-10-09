"use client";

import { useId, useState } from "react";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import styles from "./demos.module.css";
import { dollars, parseRecipients, splitPreview } from "./split";

/**
 * batch: type an amount and 2 to 5 people, and see the shares and the legs of the one transaction that
 * would carry them. Computed here in the browser; nothing is sent.
 */
export function BatchPreview({ chainName, maxLegs }: { chainName: string; maxLegs: number }) {
  const [amount, setAmount] = useState("12");
  const [people, setPeople] = useState("@alex @sam @jo");
  const amountId = useId();
  const peopleId = useId();
  const preview = splitPreview(amount, parseRecipients(people), maxLegs);

  return (
    <Receipt title={`Split preview · ${chainName}`}>
      <div className={styles.form}>
        <label className={styles.label} htmlFor={amountId}>
          Amount
          <input
            id={amountId}
            className={styles.input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className={styles.label} htmlFor={peopleId}>
          Split between
          <input
            id={peopleId}
            className={styles.input}
            value={people}
            onChange={(e) => setPeople(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <ReceiptRule />
      <div aria-live="polite">
        {preview.ok ? (
          <>
            {preview.legs.map((leg, i) => (
              <ReceiptLine key={leg.to} label={`leg ${i + 1} → ${leg.to}`}>
                {dollars(leg.cents)}
              </ReceiptLine>
            ))}
            <ReceiptLine label="one transaction" total>
              {dollars(preview.legs.reduce((sum, l) => sum + l.cents, 0))}
            </ReceiptLine>
          </>
        ) : (
          <p className={styles.error}>{preview.error}</p>
        )}
      </div>
      <ReceiptRule />
      <Fine>All the legs settle in one transaction: they all land or none do. This preview sends nothing.</Fine>
    </Receipt>
  );
}

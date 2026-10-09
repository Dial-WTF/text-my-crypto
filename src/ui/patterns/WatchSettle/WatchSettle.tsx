"use client";

import { useEffect, useState } from "react";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine } from "@/ui/primitives/Receipt/Receipt";
import styles from "./WatchSettle.module.css";

/** One payment, already worded for people: handles only, a dollar string, a state and a relative time. */
export type LatestPayment = {
  id: string;
  from: string;
  to: string;
  /** "$2.50", "0.1 TSLA" for a stock token, or "shielded" for a private send. */
  amount: string;
  network: string;
  state: string;
  when: string;
  txHash: string | null;
  explorerUrl: string | null;
};

type Props = {
  /** What the server read for this render; null when nothing has settled on the chain yet. */
  initial: LatestPayment | null;
  /** GET endpoint answering { payment: LatestPayment | null }. */
  endpoint: string;
  /** "Solana devnet". */
  network: string;
  everyMs?: number;
};

/**
 * The newest real payment on one chain, refreshed every 30 seconds while the tab is visible. Read-only:
 * it polls a cached public endpoint and keeps the last good answer if a poll fails.
 */
export function WatchSettle({ initial, endpoint, network, everyMs = 30_000 }: Props) {
  const [payment, setPayment] = useState(initial);
  const [checked, setChecked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(endpoint, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { payment: LatestPayment | null };
        if (!alive) return;
        setPayment(body.payment);
        setChecked(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }));
      } catch {
        // Keep showing the last answer; the next poll tries again.
      }
    };
    const timer = setInterval(poll, everyMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [endpoint, everyMs]);

  return (
    <Receipt title="Watch it settle">
      <div aria-live="polite" className={styles.body}>
        {payment ? (
          <>
            <ReceiptLine label={`${payment.from} → ${payment.to}`}>{payment.amount}</ReceiptLine>
            <div className={styles.meta}>
              <span>{payment.when}</span>
              <span className={styles.state}>{payment.state}</span>
              <span>{payment.network}</span>
              {payment.txHash ? <Mono value={payment.txHash} href={payment.explorerUrl} /> : null}
            </div>
          </>
        ) : (
          <p className={styles.empty}>No payment on {network} yet.</p>
        )}
      </div>
      <p className={styles.note}>
        The newest payment on {network}, from the ledger. Checks again every {Math.round(everyMs / 1000)} seconds
        {checked ? `; last checked ${checked}` : ""}.
      </p>
    </Receipt>
  );
}

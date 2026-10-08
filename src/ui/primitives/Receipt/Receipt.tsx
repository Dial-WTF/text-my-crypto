import type { ReactNode } from "react";
import styles from "./Receipt.module.css";

type ReceiptProps = {
  title: string;
  children: ReactNode;
  printing?: boolean;
};

/** A thermal-receipt card: the base surface for anything that states money or a fact. */
export function Receipt({ title, children, printing = false }: ReceiptProps) {
  return (
    <section className={`${styles.receipt} ${printing ? styles.printing : ""}`} aria-label={title}>
      <p className={styles.title}>{title}</p>
      <hr className={styles.rule} />
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export function ReceiptLine({ label, children, total = false }: { label: string; children: ReactNode; total?: boolean }) {
  return (
    <div className={`${styles.line} ${total ? styles.total : ""}`}>
      <span className={styles.label}>{label}</span>
      <span className={styles.leader} aria-hidden />
      <span className={styles.value}>{children}</span>
    </div>
  );
}

export function ReceiptRule() {
  return <hr className={styles.rule} />;
}

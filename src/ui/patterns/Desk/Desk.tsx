import type { ReactNode } from "react";
import styles from "./Desk.module.css";

/** App pages: a heading and one receipt, centred on the counter. */
export function Desk({ heading, lede, children }: { heading: string; lede?: string; children: ReactNode }) {
  return (
    <section className={styles.desk}>
      <h1 className={styles.heading}>{heading}</h1>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
      {children}
    </section>
  );
}

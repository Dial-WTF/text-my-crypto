import type { ReactNode } from "react";
import styles from "./Section.module.css";

type SectionProps = { heading: string; lede?: string; children: ReactNode };

/** A titled block of the page. Heading floats above its content; no eyebrow, no rule. */
export function Section({ heading, lede, children }: SectionProps) {
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{heading}</h2>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
      {children}
    </section>
  );
}

/** Two equal columns on wide screens, one on narrow. */
export function Split({ children }: { children: ReactNode }) {
  return <div className={styles.split}>{children}</div>;
}

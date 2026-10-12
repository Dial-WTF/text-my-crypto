import type { ReactNode } from "react";
import styles from "./Section.module.css";

type SectionProps = { heading: string; lede?: string; level?: 1 | 2; children?: ReactNode };

/**
 * A titled block of the page. Heading floats above its content; no eyebrow, no rule. `level={1}` makes
 * it the page's h1, for long pages whose first section is the title.
 */
export function Section({ heading, lede, level = 2, children }: SectionProps) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <section className={styles.section}>
      <Heading className={styles.heading}>{heading}</Heading>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
      {children}
    </section>
  );
}

/** Two equal columns on wide screens, one on narrow. */
export function Split({ children }: { children: ReactNode }) {
  return <div className={styles.split}>{children}</div>;
}

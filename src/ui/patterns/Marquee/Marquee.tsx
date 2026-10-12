import type { ReactNode } from "react";
import styles from "./Marquee.module.css";

type MarqueeProps = { kicker: string; number: string; href: string; line: string; fine?: ReactNode };

/** The fold: one statement, set as large as the viewport allows, and any small print the number needs. */
export function Marquee({ kicker, number, href, line, fine }: MarqueeProps) {
  return (
    <>
      <section className={styles.marquee}>
        <h1 className={styles.heading}>
          <span className={styles.kicker}>{kicker}</span>
          <a className={styles.number} href={href}>
            {number}
          </a>
        </h1>
        <p className={styles.line}>{line}</p>
        {fine}
      </section>
      <hr className={styles.rule} />
    </>
  );
}

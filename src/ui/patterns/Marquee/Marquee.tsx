import styles from "./Marquee.module.css";

type MarqueeProps = { kicker: string; number: string; href: string; line: string };

/** The fold: one statement, set as large as the viewport allows. */
export function Marquee({ kicker, number, href, line }: MarqueeProps) {
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
      </section>
      <hr className={styles.rule} />
    </>
  );
}

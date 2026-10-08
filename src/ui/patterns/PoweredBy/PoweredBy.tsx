import { BrandMark } from "@/ui/primitives/BrandMark/BrandMark";
import styles from "./PoweredBy.module.css";

/** Says plainly whose product this is. */
export function PoweredBy({ company, href, line }: { company: string; href: string; line: string }) {
  return (
    <section className={styles.band} aria-label={`Powered by ${company}`}>
      <a className={styles.link} href={href} target="_blank" rel="noreferrer">
        <span className={styles.mark}>
          <BrandMark />
        </span>
        <span className={styles.label}>
          <span className={styles.small}>Powered by</span>
          <span className={styles.company}>{company}</span>
        </span>
      </a>
      <p className={styles.line}>{line}</p>
    </section>
  );
}

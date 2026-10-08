import styles from "./BrandMark.module.css";

/** The Dial.Work mark, tinted by the current text colour so every theme recolours it. Size with font-size. */
export function BrandMark({ label }: { label?: string }) {
  return label ? (
    <span className={styles.mark} role="img" aria-label={label} />
  ) : (
    <span className={styles.mark} aria-hidden="true" />
  );
}

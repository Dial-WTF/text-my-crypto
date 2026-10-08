import styles from "./Mono.module.css";

export function shorten(value: string, keep = 4): string {
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** Hashes, addresses and codes. Shortened by default, full value on hover and for screen readers. */
export function Mono({ value, href, full = false }: { value: string; href?: string | null; full?: boolean }) {
  const shown = full ? value : shorten(value);
  if (href) {
    return (
      <a className={`${styles.mono} ${styles.link}`} href={href} title={value} target="_blank" rel="noreferrer">
        {shown}
      </a>
    );
  }
  return (
    <span className={styles.mono} title={value}>
      {shown}
    </span>
  );
}

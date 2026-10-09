import styles from "./Mono.module.css";
import { cx } from "@/ui/cx";

export function shorten(value: string, keep = 4): string {
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** Hashes, addresses and codes. Shortened by default, full value on hover and for screen readers. */
export function Mono({ value, href, full = false }: { value: string; href?: string | null; full?: boolean }) {
  const shown = full ? value : shorten(value);
  if (href) {
    return (
      <a
        className={cx(styles.mono, styles.link)}
        href={href}
        title={value}
        aria-label={`${value} (opens explorer in a new tab)`}
        target="_blank"
        rel="noreferrer"
      >
        {shown}
      </a>
    );
  }
  if (shown === value) {
    return <span className={styles.mono}>{value}</span>;
  }
  return (
    <span className={styles.mono} title={value}>
      <span aria-hidden="true">{shown}</span>
      <span className={styles.srOnly}>{value}</span>
    </span>
  );
}

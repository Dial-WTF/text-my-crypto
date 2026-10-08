import styles from "./Stamp.module.css";

export type StampTone = "done" | "waiting" | "bad";

/** A rubber-stamp status label. The only place the signal colour fills a surface. */
export function Stamp({ label, tone }: { label: string; tone: StampTone }) {
  return <span className={`${styles.stamp} ${styles[tone]}`}>{label}</span>;
}

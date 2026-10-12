import styles from "./Limits.module.css";

export type Limit = { value: string; label: string };

/** The operator's limits as a compact list: the number, then what it limits. Values come from settings, never copy. */
export function Limits({ items, label = "Limits" }: { items: Limit[]; label?: string }) {
  return (
    <dl className={styles.list} aria-label={label}>
      {items.map((l) => (
        <div key={l.label} className={styles.item}>
          <dt className={styles.value}>{l.value}</dt>
          <dd className={styles.label}>{l.label}</dd>
        </div>
      ))}
    </dl>
  );
}

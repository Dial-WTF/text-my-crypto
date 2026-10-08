import { Stat } from "@/ui/primitives/Stat/Stat";
import styles from "./StatStrip.module.css";

export type StatItem = { value: string; label: string };

/** A row of live numbers. Values come from the ledger, never from copy. */
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className={styles.strip}>
      {items.map((s) => (
        <Stat key={s.label} value={s.value} label={s.label} />
      ))}
    </div>
  );
}

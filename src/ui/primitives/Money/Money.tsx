import { formatUsd } from "@/lib/money";
import styles from "./Money.module.css";

/** Base-unit amount (6 decimals) rendered as dollars. */
export function Money({ amount, unit = "USDC" }: { amount: bigint; unit?: string | null }) {
  return (
    <span className={styles.money}>
      {formatUsd(amount)}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

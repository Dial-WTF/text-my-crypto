import { formatUsd } from "@/lib/money";
import { formatShares } from "@/lib/stocks";
import styles from "./Money.module.css";

/** Base-unit amount (6 decimals) rendered as dollars, or as shares of `stock` ("0.1 TSLA") when it's a stock token. */
export function Money({ amount, unit = "USDC", stock = null }: { amount: bigint; unit?: string | null; stock?: string | null }) {
  if (stock) return <span className={styles.money}>{`${formatShares(amount)} ${stock}`}</span>;
  return (
    <span className={styles.money}>
      {formatUsd(amount)}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

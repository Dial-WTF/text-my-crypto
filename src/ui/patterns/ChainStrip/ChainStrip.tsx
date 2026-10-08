import { Logo } from "@/ui/brand/Logo";
import type { LogoId } from "@/ui/brand/logoPaths";
import styles from "./ChainStrip.module.css";

export type ChainStripItem = {
  name: string;
  role: string;
  status: "live" | "next";
  statusLabel: string;
  logo: LogoId | null;
};

/** What the product runs on, said plainly: one tile per chain or service, with its real status. */
export function ChainStrip({
  heading,
  items,
  size = "regular",
}: {
  heading: string;
  items: ChainStripItem[];
  size?: "regular" | "large";
}) {
  const id = `strip-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={`${styles.strip} ${size === "large" ? styles.large : ""}`} aria-labelledby={id}>
      <h2 id={id} className={styles.heading}>
        {heading}
      </h2>
      <ul className={styles.grid}>
        {items.map((item) => (
          <li key={item.name} className={styles.item}>
            <span className={styles.mark}>
              {item.logo ? <Logo id={item.logo} title={item.name} /> : null}
              <span className={item.logo ? styles.name : styles.wordmark}>{item.name}</span>
            </span>
            <p className={styles.role}>{item.role}</p>
            <span className={`${styles.status} ${styles[item.status]}`}>{item.statusLabel}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

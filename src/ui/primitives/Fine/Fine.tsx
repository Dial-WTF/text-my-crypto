import type { ReactNode } from "react";
import styles from "./Fine.module.css";

/** Small print on a card: a caption, or with `caps` a spaced uppercase label above a group. */
export function Fine({ caps = false, children }: { caps?: boolean; children: ReactNode }) {
  return <p className={caps ? styles.caps : styles.fine}>{children}</p>;
}

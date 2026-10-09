import type { ReactNode } from "react";
import styles from "./Prose.module.css";

/** Long-form reading text on the canvas: terms, privacy, FAQ answers. Styles the plain elements inside it. */
export function Prose({ children }: { children: ReactNode }) {
  return <div className={styles.prose}>{children}</div>;
}

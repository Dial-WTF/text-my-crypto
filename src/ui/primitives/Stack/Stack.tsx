import type { ReactNode } from "react";
import styles from "./Stack.module.css";
import { cx } from "@/ui/cx";

type Gap = "2xs" | "sm" | "md" | "lg" | "xl";

/** Vertical rhythm. The only way pages space their children. */
export function Stack({ gap = "md", children }: { gap?: Gap; children: ReactNode }) {
  return <div className={cx(styles.stack, styles[`gap-${gap}`])}>{children}</div>;
}

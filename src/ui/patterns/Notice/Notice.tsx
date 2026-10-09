import type { ReactNode } from "react";
import styles from "./Notice.module.css";
import { cx } from "@/ui/cx";

export type NoticeTone = "info" | "error" | "success";

/** One line of feedback inside a receipt. Errors are announced to screen readers. */
export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  return (
    <p className={cx(styles.notice, styles[tone])} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

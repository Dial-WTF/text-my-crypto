import type { ReactNode } from "react";
import { formatPhone } from "@/lib/phone";
import { Wordmark } from "@/ui/primitives/Wordmark/Wordmark";
import styles from "./SiteShell.module.css";

type SiteShellProps = { operatorNumber: string; children: ReactNode; colophon?: ReactNode };

/** Page chrome: edge-aligned nav (wordmark · one action) and a dense mono colophon. */
export function SiteShell({ operatorNumber, children, colophon }: SiteShellProps) {
  return (
    <>
      <header className={styles.nav}>
        <Wordmark />
        <a className={styles.cta} href={`sms:${operatorNumber}?&body=hi`}>
          Text {formatPhone(operatorNumber)}
        </a>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.colophon}>{colophon}</footer>
    </>
  );
}

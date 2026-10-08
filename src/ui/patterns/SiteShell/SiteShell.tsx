import type { ReactNode } from "react";
import { formatPhone } from "@/lib/phone";
import { themeChoice } from "@/ui/theme/server";
import { Wordmark } from "@/ui/primitives/Wordmark/Wordmark";
import { ThemeToggle } from "../ThemeToggle/ThemeToggle";
import styles from "./SiteShell.module.css";

type SiteShellProps = { operatorNumber: string; children: ReactNode; colophon?: ReactNode };

/** Page chrome: edge-aligned nav (wordmark · one action) and a dense mono colophon. */
export async function SiteShell({ operatorNumber, children, colophon }: SiteShellProps) {
  const theme = await themeChoice();
  return (
    <>
      <header className={styles.nav}>
        <Wordmark />
        <div className={styles.tools}>
          <ThemeToggle initial={theme} />
          <a className={styles.cta} href={`sms:${operatorNumber}?&body=hi`}>
            Text {formatPhone(operatorNumber)}
          </a>
        </div>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.colophon}>{colophon}</footer>
    </>
  );
}

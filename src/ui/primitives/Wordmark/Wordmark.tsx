import Link from "next/link";
import styles from "./Wordmark.module.css";

export function Wordmark() {
  return (
    <Link href="/" className={styles.wordmark} aria-label="Dial operator, home">
      Dial<span className={styles.dot}>.</span>operator
    </Link>
  );
}

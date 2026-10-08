import Link from "next/link";
import { BrandMark } from "../BrandMark/BrandMark";
import styles from "./Wordmark.module.css";

export function Wordmark() {
  return (
    <Link href="/" className={styles.wordmark} aria-label="Dial operator by Dial.Work, home">
      <span className={styles.mark}>
        <BrandMark />
      </span>
      <span className={styles.name}>
        Dial<span className={styles.dot}>.</span>operator
      </span>
      <span className={styles.by}>by Dial.Work</span>
    </Link>
  );
}

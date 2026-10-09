import Link from "next/link";
import { BrandMark } from "../BrandMark/BrandMark";
import styles from "./Wordmark.module.css";

/** `byline` ("by Dial.Work") shows after the name when the site's SHOW_BYLINE flag is on. */
export function Wordmark({ byline = null }: { byline?: string | null }) {
  return (
    <Link href="/" className={styles.wordmark} aria-label={`Dial operator${byline ? ` ${byline}` : ""}, home`}>
      <span className={styles.mark}>
        <BrandMark />
      </span>
      <span className={styles.name}>
        Dial<span className={styles.dot}>.</span>operator
      </span>
      {byline ? <span className={styles.by}>{byline}</span> : null}
    </Link>
  );
}

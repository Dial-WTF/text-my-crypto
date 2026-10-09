import styles from "./FooterLinks.module.css";

export type FooterLink = { href: string; label: string };

/** The site's other pages, one wrapping row at the top of the colophon. */
export function FooterLinks({ links, label = "Site" }: { links: FooterLink[]; label?: string }) {
  return (
    <nav className={styles.nav} aria-label={label}>
      <ul className={styles.list}>
        {links.map((l) => (
          <li key={l.href}>
            <a className={styles.link} href={l.href}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

import { Logo } from "@/ui/brand/Logo";
import type { LogoId } from "@/ui/brand/logoPaths";
import type { BrandId } from "@/ui/theme/brands";
import { ThemeScope } from "@/ui/theme/ThemeScope";
import styles from "./ChainStrip.module.css";

export type ChainStripItem = {
  name: string;
  role: string;
  status: "live" | "next";
  statusLabel: string;
  logo: LogoId | null;
  /** The tile links here; the whole tile is the target. */
  href?: string;
  /** The link's accessible name, e.g. "Solana: how Dial uses it". Defaults to the name. */
  linkLabel?: string;
  /** The tile's brand. A linked tile takes it on hover and focus: glow, tint, logo, name and cue. */
  brand?: BrandId;
  /** Wear the brand at rest too: the logo, top band and live badge (the /judges index). */
  brandAtRest?: boolean;
};

/** What the product runs on, said plainly: one tile per chain or service, with its real status. */
export function ChainStrip({
  heading,
  items,
  size = "regular",
}: {
  heading: string;
  items: ChainStripItem[];
  size?: "regular" | "large";
}) {
  const id = `strip-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className={`${styles.strip} ${size === "large" ? styles.large : ""}`} aria-labelledby={id}>
      <h2 id={id} className={styles.heading}>
        {heading}
      </h2>
      <ul className={styles.grid}>
        {items.map((item) => {
          const name = <span className={item.logo ? styles.name : styles.wordmark}>{item.name}</span>;
          const body = (
            <>
              <span className={styles.mark}>
                {item.logo ? <Logo id={item.logo} title={item.name} /> : null}
                {item.href ? (
                  <a className={styles.link} href={item.href} aria-label={item.linkLabel}>
                    {name}
                  </a>
                ) : (
                  name
                )}
              </span>
              <p className={styles.role}>{item.role}</p>
              <span className={`${styles.status} ${styles[item.status]}`}>{item.statusLabel}</span>
              {item.href ? (
                // The link's own name already says where it goes; this is the visible cue.
                <span className={styles.cue} aria-hidden="true">
                  How Dial uses {item.name}
                  <span className={styles.arrow}>→</span>
                </span>
              ) : null}
            </>
          );
          // A linked name stays on one line; a long one ("Robinhood Chain") gets a smaller size to fit.
          const long = item.name.length > 10;
          const className = [
            styles.item,
            item.href ? styles.linked : "",
            item.brand && item.brandAtRest ? styles.branded : "",
            item.brand && !item.brandAtRest ? styles.restHouse : "",
            long ? styles.long : "",
          ]
            .filter(Boolean)
            .join(" ");
          return item.brand ? (
            <ThemeScope key={item.name} as="li" brand={item.brand} className={className}>
              {body}
            </ThemeScope>
          ) : (
            <li key={item.name} className={className}>
              {body}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

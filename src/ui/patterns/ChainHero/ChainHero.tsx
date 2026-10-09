import { Logo } from "@/ui/brand/Logo";
import type { LogoId } from "@/ui/brand/logoPaths";
import styles from "./ChainHero.module.css";
import { cx } from "@/ui/cx";

type ChainHeroProps = {
  name: string;
  logo: LogoId;
  /** "Live · devnet", from chainStatuses. */
  statusLabel: string;
  live: boolean;
  /** "Base Sepolia". */
  network: string;
  lede: string;
};

/**
 * A chain page's title: a full-width band in the brand's hero fill with its logo large, its name and its
 * real status. Colours come from the surrounding ThemeScope brand (--fill-hero, --color-on-hero), so the
 * hero has none of its own.
 */
export function ChainHero({ name, logo, statusLabel, live, network, lede }: ChainHeroProps) {
  return (
    <section className={styles.hero}>
      <div className={styles.inner}>
        {/* The name follows, so the logo is decoration here. */}
        <span className={styles.logo} aria-hidden="true">
          <Logo id={logo} title={name} />
        </span>
        <h1 className={styles.heading}>{name}</h1>
        <p className={styles.meta}>
          <span className={cx(styles.status, live ? styles.live : "")}>{statusLabel}</span>
          <span className={styles.network}>{network}</span>
        </p>
        <p className={styles.lede}>{lede}</p>
      </div>
    </section>
  );
}

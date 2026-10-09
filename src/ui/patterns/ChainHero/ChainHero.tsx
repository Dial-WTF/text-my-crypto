import { Logo } from "@/ui/brand/Logo";
import type { LogoId } from "@/ui/brand/logoPaths";
import styles from "./ChainHero.module.css";

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
 * A chain page's title: the brand's band, its logo and name, and its real status. Colours come from the
 * surrounding ThemeScope brand, so the hero has none of its own.
 */
export function ChainHero({ name, logo, statusLabel, live, network, lede }: ChainHeroProps) {
  return (
    <section className={styles.hero}>
      <div className={styles.band} aria-hidden="true" />
      <h1 className={styles.heading}>
        {/* The name follows, so the logo is decoration here. */}
        <span className={styles.logo} aria-hidden="true">
          <Logo id={logo} title={name} />
        </span>
        <span className={styles.name}>{name}</span>
      </h1>
      <p className={styles.meta}>
        <span className={`${styles.status} ${live ? styles.live : ""}`}>{statusLabel}</span>
        <span>{network}</span>
      </p>
      <p className={styles.lede}>{lede}</p>
    </section>
  );
}

import type { ReactNode } from "react";
import type { BrandId } from "./brands";
import type { ThemeId } from "./themes";
import styles from "./ThemeScope.module.css";

type ThemeScopeProps = {
  /** A mode for this subtree only (light, dark, matrix). Leave out to keep the reader's choice. */
  theme?: ThemeId;
  /** Recolours accents and fills inside this subtree. Canvas and text stay with the mode. */
  brand?: BrandId;
  /**
   * "page" lets the brand take the whole page: headings, links, list markers, rules, buttons, card edges
   * and the hero, and in matrix the text and glow too. Leave out for a tile or swatch, which keeps the
   * page's look and recolours only its own accents.
   */
  extent?: "page";
  /** "off" hides the page's theme backdrop (the matrix rain) while this scope is on the page. */
  backdrop?: "off";
  as?: "div" | "section" | "li";
  className?: string;
  children?: ReactNode;
};

/**
 * Applies a theme and/or brand to a subtree. Components read role tokens (--color-*), so anything
 * inside picks the scope up with no props of its own, and scopes nest.
 */
export function ThemeScope({ theme, brand, extent, backdrop, as: Tag = "div", className, children }: ThemeScopeProps) {
  return (
    <Tag
      className={[styles.scope, theme ? styles.themed : "", brand && extent ? styles.page : "", className ?? ""].filter(Boolean).join(" ")}
      data-theme={theme}
      data-brand={brand}
      data-brand-extent={brand ? extent : undefined}
      data-backdrop={backdrop}
    >
      {children}
    </Tag>
  );
}

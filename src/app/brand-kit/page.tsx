import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { ButtonLink } from "@/ui/primitives/Button/Button";
import { Colophon } from "../colophon";
import styles from "./brand-kit.module.css";
import { ASSETS, COLORS, FONTS, KIT_ZIP } from "./kit";

export const metadata: Metadata = {
  title: "Brand kit",
  description: "The Dial Operator logo, mark, app icon, colors and fonts, ready to download.",
  alternates: { canonical: "/brand-kit" },
};

export default function BrandKitPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        level={1}
        heading="Brand kit"
        lede="The Dial Operator logo, mark, colors and type. Download what you need, or take the whole kit in one zip."
      >
        <div>
          <ButtonLink href={KIT_ZIP} download>
            Download the full kit (.zip)
          </ButtonLink>
        </div>
      </Section>

      <Section heading="Logos">
        <div className={styles.grid}>
          {ASSETS.map((a) => (
            <figure key={a.name} className={styles.tile}>
              <div className={`${styles.preview ?? ""} ${(a.ground === "dark" ? styles.dark : styles.light) ?? ""}`}>
                {/* Brand files are shown as they are, at their own proportions. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.preview} alt={`${a.name} preview`} loading="lazy" />
              </div>
              <figcaption>
                <p className={styles.name}>{a.name}</p>
                <p className={styles.note}>{a.note}</p>
              </figcaption>
              <ul className={styles.links}>
                {a.downloads.map((d) => (
                  <li key={d.href}>
                    <a href={d.href} download>
                      {d.label}
                    </a>
                  </li>
                ))}
              </ul>
            </figure>
          ))}
        </div>
      </Section>

      <Section heading="Colors">
        <div className={styles.swatches}>
          {COLORS.map((c) => (
            <figure key={c.hex} className={styles.swatch}>
              <div className={styles.chip} style={{ background: c.hex }} />
              <figcaption>
                <p className={styles.name}>
                  {c.name} <code>{c.hex}</code>
                </p>
                <p className={styles.note}>{c.use}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section heading="Type and use">
        <Prose>
          <ul>
            {FONTS.map((f) => (
              <li key={f.name}>
                <a href={f.href}>{f.name}</a>: {f.use}. Free under the SIL Open Font License.
              </li>
            ))}
          </ul>
          <p>
            The name is <strong>Dial Operator</strong>, two words, both capitalized. The tagline is{" "}
            <strong>Dial Up Banking</strong>. The logo files have their text converted to outlines, so they need no fonts.
          </p>
          <p>
            Keep the lockup on the background it was made for, leave clear space around it about the height of the $, and
            don&apos;t recolor, stretch or rearrange it.
          </p>
        </Prose>
      </Section>
    </SiteShell>
  );
}

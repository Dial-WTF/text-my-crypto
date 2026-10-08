"use client";

import { useState } from "react";
import { applyTheme } from "@/ui/theme/client";
import { THEME_CHOICES, type ThemeChoice } from "@/ui/theme/themes";
import styles from "./ThemeToggle.module.css";

/** Theme picker. Writes a cookie so the server renders the same theme next time. */
export function ThemeToggle({ initial }: { initial: ThemeChoice }) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    applyTheme(next);
  };

  return (
    <fieldset className={styles.toggle}>
      <legend className={styles.legend}>Theme</legend>
      {THEME_CHOICES.map((t) => (
        <label key={t.id} className={styles.option}>
          <input
            className={styles.input}
            type="radio"
            name="theme"
            value={t.id}
            checked={choice === t.id}
            onChange={() => pick(t.id)}
          />
          <span className={styles.label}>{t.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

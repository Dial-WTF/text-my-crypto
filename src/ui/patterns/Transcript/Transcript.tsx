"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import styles from "./Transcript.module.css";
import { cx } from "@/ui/cx";

export type TranscriptLine = { from: "you" | "operator"; text: string };

const STEP_MS = 1400;
const HOLD_MS = 4000;
const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const q = window.matchMedia(REDUCED);
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED).matches,
    () => true,
  );
}

/** A real exchange with the operator, revealed one text at a time. No device chrome: the words are the demo. */
export function Transcript({ lines, label }: { lines: TranscriptLine[]; label: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(lines.length);

  useEffect(() => {
    if (reduced) return;
    let n = lines.length;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      n = n >= lines.length ? 1 : n + 1;
      setShown(n);
      timer = setTimeout(tick, n >= lines.length ? HOLD_MS : STEP_MS);
    };
    timer = setTimeout(tick, HOLD_MS);
    return () => clearTimeout(timer);
  }, [lines.length, reduced]);

  const visible = reduced ? lines.length : shown;

  return (
    <ol className={styles.transcript} aria-label={label}>
      {lines.map((l, i) => (
        <li
          key={`${l.from}-${i}`}
          className={cx(styles.bubble, styles[l.from], i < visible ? "" : styles.hidden)}
          aria-hidden={i < visible ? undefined : true}
        >
          <span className={styles.who}>{l.from === "you" ? "you" : "operator"}</span>
          {l.text}
        </li>
      ))}
    </ol>
  );
}

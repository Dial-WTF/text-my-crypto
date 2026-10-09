"use client";

import { type FormEvent, useId, useState } from "react";
import { Button } from "@/ui/primitives/Button/Button";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import styles from "./demos.module.css";

type Answer = { name: string; address: string | null } | { error: string };

/** names: type a name, see the address it points to now. Read-only; calls the chain's cached lookup route. */
export function NameLookup({
  endpoint,
  suffixes,
  example,
  explorerBase,
}: {
  endpoint: string;
  suffixes: string[];
  /** Shown as the input's placeholder. */
  example: string;
  /** Explorer address URL with the address left off the end; none where the explorer doesn't serve pages. */
  explorerBase?: string;
}) {
  const [name, setName] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  const lookUp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}`);
      setAnswer((await res.json()) as Answer);
    } catch {
      setAnswer({ error: "The lookup didn't answer. Try again in a minute." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Receipt title="Name lookup">
      <form className={styles.form} onSubmit={lookUp}>
        <label className={styles.label} htmlFor={id}>
          Name ({suffixes.join(" or ")})
          <input
            id={id}
            className={styles.input}
            value={name}
            placeholder={example}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <Button type="submit" state={busy ? "loading" : "idle"}>
          Look it up
        </Button>
      </form>
      <ReceiptRule />
      <div aria-live="polite">
        {answer === null ? (
          <Fine>The address a name points to right now. Nothing is sent.</Fine>
        ) : "error" in answer ? (
          <p className={styles.error}>{answer.error}</p>
        ) : answer.address ? (
          <ReceiptLine label={answer.name}>
            <Mono value={answer.address} href={explorerBase ? `${explorerBase}${answer.address}` : null} />
          </ReceiptLine>
        ) : (
          <Fine>{answer.name} doesn&apos;t point to an address.</Fine>
        )}
      </div>
    </Receipt>
  );
}

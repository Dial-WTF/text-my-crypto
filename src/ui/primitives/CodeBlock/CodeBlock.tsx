import styles from "./CodeBlock.module.css";

/** Copyable code on a card surface: commands, config, endpoints. */
export function CodeBlock({ label, code }: { label?: string; code: string }) {
  return (
    <div>
      {label ? <span className={styles.label}>{label}</span> : null}
      <pre className={styles.block}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

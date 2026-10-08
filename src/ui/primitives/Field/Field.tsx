import { type InputHTMLAttributes, useId } from "react";
import styles from "./Field.module.css";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> & {
  label: string;
  hint?: string;
  error?: string | null;
};

export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input {...input} id={id} className={styles.input} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {error ? (
        <p id={`${id}-error`} role="alert" className={styles.error}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export type ButtonState = "idle" | "loading" | "error" | "success";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: "solid" | "outline";
  surface?: "paper" | "carbon";
  state?: ButtonState;
  full?: boolean;
};

export function Button({
  variant = "solid",
  surface = "paper",
  state = "idle",
  full = false,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    surface === "paper" ? styles.onPaper : styles.onCarbon,
    full ? styles.full : "",
  ].join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      data-state={state}
      aria-busy={state === "loading" || undefined}
      disabled={disabled || state === "loading"}
    />
  );
}

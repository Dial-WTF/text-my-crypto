import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

export type ButtonState = "idle" | "loading" | "error" | "success";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: "solid" | "outline";
  surface?: "card" | "canvas";
  state?: ButtonState;
  full?: boolean;
};

type Look = { variant?: "solid" | "outline"; surface?: "card" | "canvas"; full?: boolean };

function classesFor({ variant = "solid", surface = "card", full = false }: Look): string {
  return [styles.button, styles[variant], surface === "card" ? styles.onCard : styles.onCanvas, full ? styles.full : ""].join(" ");
}

/** A link that looks like a Button: for actions that leave the page (sms:, wallet apps, other pages). */
export function ButtonLink({
  variant,
  surface,
  full,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & Look) {
  return <a {...rest} className={classesFor({ variant, surface, full })} />;
}

export function Button({
  variant = "solid",
  surface = "card",
  state = "idle",
  full = false,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = classesFor({ variant, surface, full });
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

"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/ui/primitives/Button/Button";

/** Copies `value` to the clipboard and says so for two seconds. If the clipboard is blocked, it stays quiet. */
export function CopyButton({ value, label = "Copy", full = false }: { value: string; label?: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button variant="outline" full={full} state={copied ? "success" : "idle"} onClick={onClick} aria-live="polite">
      {copied ? "Copied" : label}
    </Button>
  );
}

const subscribeNever = () => () => {};
const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/** Opens the phone's share sheet for a link. Renders nothing where the browser can't share. */
export function ShareLink({
  url,
  title,
  label = "Share",
  full = false,
}: {
  url: string;
  title: string;
  label?: string;
  full?: boolean;
}) {
  const supported = useSyncExternalStore(subscribeNever, canShare, () => false);
  if (!supported) return null;
  const onClick = () => {
    navigator.share({ url, title }).catch(() => {});
  };
  return (
    <Button variant="outline" full={full} onClick={onClick}>
      {label}
    </Button>
  );
}

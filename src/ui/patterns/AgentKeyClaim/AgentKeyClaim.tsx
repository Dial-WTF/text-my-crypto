"use client";

import { type FormEvent, useState } from "react";
import { Button, type ButtonState } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Notice } from "../Notice/Notice";
import styles from "./AgentKeyClaim.module.css";
import { formText } from "@/lib/form";

export type AgentKeyResult = { ok: true; key: string; mcpUrl: string } | { ok: false; message: string };

type AgentKeyClaimProps = {
  token: string;
  redeem: (token: string, code: string) => Promise<AgentKeyResult>;
};

function clientConfig(mcpUrl: string, key: string): string {
  return JSON.stringify(
    { mcpServers: { dial: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } },
    null,
    2,
  );
}

/** Trades the texted code for an agent key, then shows the key exactly once. The server action is injected. */
export function AgentKeyClaim({ token, redeem }: AgentKeyClaimProps) {
  const [state, setState] = useState<ButtonState>("idle");
  const [result, setResult] = useState<AgentKeyResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), "code").trim();
    setState("loading");
    setResult(null);
    const r = await redeem(token, code).catch(
      (): AgentKeyResult => ({ ok: false, message: "Something went wrong. Try again." }),
    );
    setResult(r);
    setState(r.ok ? "success" : "error");
  };

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };

  if (result?.ok) {
    const config = clientConfig(result.mcpUrl, result.key);
    return (
      <Stack gap="sm">
        <Notice tone="success">Your agent key. It won&rsquo;t be shown again.</Notice>
        <pre className={styles.secret}>{result.key}</pre>
        <Button full onClick={() => void copy("key", result.key)}>
          {copied === "key" ? "Copied" : "Copy key"}
        </Button>
        <p className={styles.caption}>MCP client config</p>
        <pre className={styles.secret}>{config}</pre>
        <Button full variant="outline" onClick={() => void copy("config", config)}>
          {copied === "config" ? "Copied" : "Copy config"}
        </Button>
        <Notice tone="info">Text &ldquo;revoke agents&rdquo; to the operator anytime to turn this key off.</Notice>
      </Stack>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Stack gap="sm">
        <Field
          label="Code from the operator"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          hint="It's in the same text as this link."
        />
        <Button type="submit" full state={state}>
          Show my agent key
        </Button>
        {result ? <Notice tone="error">{result.message}</Notice> : null}
      </Stack>
    </form>
  );
}

"use client";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { startRegistration } from "@simplewebauthn/browser";
import { type FormEvent, useState } from "react";
import { Button, type ButtonState } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Stack } from "@/ui/primitives/Stack/Stack";
import type { ActionResult } from "../ApprovePanel/ApprovePanel";
import { Notice } from "../Notice/Notice";
import { formText } from "@/lib/form";

/** Registration options once the texted code checks out, or why not. */
export type PasskeyBegin = { ok: true; options: PublicKeyCredentialCreationOptionsJSON } | { ok: false; message: string };

export type PasskeyActions = {
  begin: (token: string, code: string) => Promise<PasskeyBegin>;
  finish: (token: string, response: RegistrationResponseJSON) => Promise<ActionResult>;
};

/** Adds a passkey to an existing account, after the code texted with the link. Server actions are injected. */
export function PasskeySetup({ token, actions }: { token: string; actions: PasskeyActions }) {
  const [state, setState] = useState<ButtonState>("idle");
  const [result, setResult] = useState<ActionResult | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), "code").trim();
    setState("loading");
    setResult(null);
    let r: ActionResult;
    try {
      const begun = await actions.begin(token, code);
      r = begun.ok ? await actions.finish(token, await startRegistration({ optionsJSON: begun.options })) : begun;
    } catch {
      r = { ok: false, message: "Passkey setup was cancelled or isn't supported on this device." };
    }
    setResult(r);
    setState(r.ok ? "success" : "error");
  };

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Stack gap="sm">
        {result?.ok ? null : (
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
        )}
        <Button type="submit" full state={state} disabled={result?.ok}>
          {result?.ok ? "Passkey added" : state === "loading" ? "Waiting for your device…" : "Create passkey"}
        </Button>
        {result ? <Notice tone={result.ok ? "success" : "error"}>{result.message}</Notice> : null}
      </Stack>
    </form>
  );
}

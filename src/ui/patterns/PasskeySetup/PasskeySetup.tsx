"use client";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { Button, type ButtonState } from "@/ui/primitives/Button/Button";
import { Stack } from "@/ui/primitives/Stack/Stack";
import type { ActionResult } from "../ApprovePanel/ApprovePanel";
import { Notice } from "../Notice/Notice";

export type PasskeyActions = {
  begin: (token: string) => Promise<PublicKeyCredentialCreationOptionsJSON | null>;
  finish: (token: string, response: RegistrationResponseJSON) => Promise<ActionResult>;
};

/** Adds a passkey to an existing account. Server actions are injected. */
export function PasskeySetup({ token, actions }: { token: string; actions: PasskeyActions }) {
  const [state, setState] = useState<ButtonState>("idle");
  const [result, setResult] = useState<ActionResult | null>(null);

  const onClick = async () => {
    setState("loading");
    setResult(null);
    let r: ActionResult;
    try {
      const options = await actions.begin(token);
      r = options
        ? await actions.finish(token, await startRegistration({ optionsJSON: options }))
        : { ok: false, message: "This link expired. Text “upgrade” to the operator for a new one." };
    } catch {
      r = { ok: false, message: "Passkey setup was cancelled or isn't supported on this device." };
    }
    setResult(r);
    setState(r.ok ? "success" : "error");
  };

  return (
    <Stack gap="sm">
      <Button full state={state} onClick={() => void onClick()} disabled={result?.ok}>
        {result?.ok ? "Passkey added" : state === "loading" ? "Waiting for your device…" : "Create passkey"}
      </Button>
      {result ? <Notice tone={result.ok ? "success" : "error"}>{result.message}</Notice> : null}
    </Stack>
  );
}

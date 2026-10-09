"use client";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { Button, type ButtonState } from "@/ui/primitives/Button/Button";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Notice } from "../Notice/Notice";

export type PasskeySignInActions = {
  options: () => Promise<PublicKeyCredentialRequestOptionsJSON>;
  finish: (response: AuthenticationResponseJSON) => Promise<{ ok: boolean }>;
};

/** Signs in with whichever passkey this device holds for Dial. The server actions are injected. */
export function PasskeySignIn({ actions, next }: { actions: PasskeySignInActions; next: string }) {
  const [state, setState] = useState<ButtonState>("idle");
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setState("loading");
    setError(null);
    try {
      const r = await actions.finish(await startAuthentication({ optionsJSON: await actions.options() }));
      if (!r.ok) throw new Error("not verified");
      setState("success");
      window.location.assign(next);
    } catch {
      setState("error");
      setError("That passkey didn't work. Text “wallet” instead, or add a passkey by texting “upgrade”.");
    }
  };

  return (
    <Stack gap="sm">
      <Button full variant="outline" state={state} onClick={onClick}>
        Sign in with a passkey
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Stack>
  );
}

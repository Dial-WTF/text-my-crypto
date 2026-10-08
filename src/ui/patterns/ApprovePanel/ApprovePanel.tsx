"use client";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { startAuthentication } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, type ButtonState } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Notice } from "../Notice/Notice";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export type ApproveActions = {
  beginPasskey: (intentId: string) => Promise<PublicKeyCredentialRequestOptionsJSON | null>;
  finishPasskey: (intentId: string, response: AuthenticationResponseJSON) => Promise<ActionResult>;
  approveWithCode: (intentId: string, code: string) => Promise<ActionResult>;
};

type ApprovePanelProps = {
  intentId: string;
  passkey: boolean;
  code: boolean;
  actions: ApproveActions;
};

/** Approve a payment with a passkey (one tap) or the code the operator texted. Server actions are injected. */
export function ApprovePanel({ intentId, passkey, code, actions }: ApprovePanelProps) {
  const router = useRouter();
  const [state, setState] = useState<ButtonState>("idle");
  const [result, setResult] = useState<ActionResult | null>(null);

  const finish = (r: ActionResult) => {
    setResult(r);
    setState(r.ok ? "success" : "error");
    if (r.ok) router.refresh();
  };

  const onPasskey = async () => {
    setState("loading");
    setResult(null);
    try {
      const options = await actions.beginPasskey(intentId);
      if (!options) return finish({ ok: false, message: "This payment can't be approved any more." });
      finish(await actions.finishPasskey(intentId, await startAuthentication({ optionsJSON: options })));
    } catch {
      finish({ ok: false, message: "Passkey approval was cancelled or failed. Nothing was sent." });
    }
  };

  const onCode = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setState("loading");
    setResult(null);
    finish(await actions.approveWithCode(intentId, value));
  };

  return (
    <Stack gap="sm">
      {passkey ? (
        <Button full state={state} onClick={onPasskey}>
          {state === "loading" ? "Waiting for your passkey…" : "Approve with passkey"}
        </Button>
      ) : null}
      {code ? (
        <form onSubmit={onCode}>
          <Stack gap="sm">
            <Field
              label="Code from the operator"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              hint="Or just reply to the text with it."
            />
            <Button type="submit" variant={passkey ? "outline" : "solid"} full state={passkey ? "idle" : state}>
              Approve with code
            </Button>
          </Stack>
        </form>
      ) : null}
      {!passkey && !code ? <Notice tone="info">Approve this one from your phone: reply to the operator&rsquo;s text.</Notice> : null}
      {result ? <Notice tone={result.ok ? "success" : "error"}>{result.message}</Notice> : null}
    </Stack>
  );
}

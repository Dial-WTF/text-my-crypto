import { ButtonLink, Button } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Notice } from "../Notice/Notice";
import { PasskeySignIn, type PasskeySignInActions } from "./PasskeySignIn";

/** Signed out: text "wallet" for a one-time link, or use a passkey. */
export function WalletSignIn({ smsUri, passkey }: { smsUri: string; passkey: PasskeySignInActions }) {
  return (
    <Receipt title="Dial wallet · sign in">
      <Stack gap="sm">
        <Fine caps>With your phone</Fine>
        <ButtonLink href={smsUri} full>
          Text “wallet” to the operator
        </ButtonLink>
        <Fine>It texts back a link and a code that open your wallet. Works on any phone.</Fine>
      </Stack>
      <ReceiptRule />
      <Stack gap="sm">
        <Fine caps>Or with a passkey</Fine>
        <PasskeySignIn actions={passkey} next="/wallet" />
      </Stack>
    </Receipt>
  );
}

/** The page a texted wallet link opens: enter the code from the same text. Works without JavaScript. */
export function WalletCodeForm({
  token,
  action,
  error,
}: {
  token: string;
  action: (form: FormData) => Promise<void>;
  error: string | null;
}) {
  return (
    <Receipt title="Dial wallet · sign in">
      <form action={action}>
        <Stack gap="sm">
          <input type="hidden" name="token" value={token} />
          <Field
            label="Code from the operator"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 \-]{6,8}"
            required
            error={error}
          />
          <Button type="submit" full>
            Open my wallet
          </Button>
        </Stack>
      </form>
    </Receipt>
  );
}

/** Shown when a texted link is used up or expired. */
export function WalletLinkClosed() {
  return <Notice tone="info">This link expired or was already used. Text “wallet” to the operator for a new one.</Notice>;
}

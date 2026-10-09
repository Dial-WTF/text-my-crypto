import { ButtonLink, Button } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Notice } from "../Notice/Notice";
import { PasskeySignIn, type PasskeySignInActions } from "./PasskeySignIn";

/** Where the sign-in form posts. A plain form POST: the response sets the cookie and 303s to /wallet. */
const SIGN_IN_PATH = "/api/wallet/sign-in";

/** Signed out: text "wallet" for your wallet link and a code, or use a passkey. */
export function WalletSignIn({ smsUri, passkey }: { smsUri: string; passkey: PasskeySignInActions }) {
  return (
    <Receipt title="Dial wallet · sign in">
      <Stack gap="sm">
        <Fine caps>With your phone</Fine>
        <ButtonLink href={smsUri} full>
          Text “wallet” to the operator
        </ButtonLink>
        <Fine>It texts back your wallet link and a code that opens it. Works on any phone.</Fine>
      </Stack>
      <ReceiptRule />
      <Stack gap="sm">
        <Fine caps>Or with a passkey</Fine>
        <PasskeySignIn actions={passkey} next="/wallet" />
      </Stack>
    </Receipt>
  );
}

/**
 * The code form on /@handle/wallet (`handle`) and on older texted /wallet/in/<token> links (`token`).
 * A plain HTML form: it works the same with or without JavaScript.
 */
export function WalletCodeForm({
  who,
  error,
  getCode,
}: {
  who: { handle: string } | { token: string };
  error: string | null;
  /** An sms: link that texts WALLET for a new code, and the number it texts. */
  getCode?: { smsUri: string; number: string };
}) {
  return (
    <Receipt title="Dial wallet · sign in">
      <form method="post" action={SIGN_IN_PATH}>
        <Stack gap="sm">
          {"handle" in who ? (
            <input type="hidden" name="handle" value={who.handle} />
          ) : (
            <input type="hidden" name="token" value={who.token} />
          )}
          <Field
            label="Code from the operator"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 \-]{6,8}"
            maxLength={8}
            required
            error={error}
          />
          <Button type="submit" full>
            Open my wallet
          </Button>
        </Stack>
      </form>
      {getCode ? (
        <>
          <ReceiptRule />
          {/* A text link, not a button: buttons don't wrap, and the number has to fit a phone screen. */}
          <Fine>
            <a href={getCode.smsUri}>Text WALLET to {getCode.number} for a code.</a> Each code works once, for 15 minutes,
            and a new one replaces the last.
          </Fine>
        </>
      ) : null}
    </Receipt>
  );
}

/** The words for the sign-in handler's ?error= back on the form. */
export function codeError(error: string | undefined): string | null {
  if (error === "code") return "That code didn't match. Check the operator's last text.";
  if (error === "closed") return "That code expired, was used, or had too many tries. Text WALLET to the operator for a new one.";
  return null;
}

/** Shown when a texted link is used up or expired. */
export function WalletLinkClosed() {
  return <Notice tone="info">This link expired or was already used. Text “wallet” to the operator for a new one.</Notice>;
}

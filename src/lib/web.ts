import { env } from "@/lib/env";
import { type RelyingParty, relyingParty } from "@/lib/passkeys";

/** WebAuthn relying party derived from the public app URL. */
export function rp(): RelyingParty {
  return relyingParty(env().APP_URL);
}

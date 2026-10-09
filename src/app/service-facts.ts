import { type Chain, CHAINS, chainLabel } from "@/lib/chains";
import { env } from "@/lib/env";
import { networkName } from "@/lib/ledger";
import { activeChains, getAdapters } from "@/lib/settlement";
import { settlesOn } from "./landing-content";

/** The limits the operator enforces, as people read them ("$50"). */
export type Limits = { perPayment: string; perDay: string; passkeyAbove: string; signupDrop: string; escrowDays: number };

/** Production's settings (wrangler.jsonc and the env defaults), for when the environment can't be read. */
export const DEFAULT_LIMITS: Limits = { perPayment: "$50", perDay: "$200", passkeyAbove: "$20", signupDrop: "$2", escrowDays: 7 };

const usd = (v: string) => `$${v}`;

/** The limits running now. Public pages must render even when secrets are missing, so this never throws. */
export function limits(): Limits {
  try {
    const e = env();
    return {
      perPayment: usd(e.PER_TX_CAP_USD),
      perDay: usd(e.PER_DAY_CAP_USD),
      passkeyAbove: usd(e.PASSKEY_THRESHOLD_USD),
      signupDrop: usd(e.SIGNUP_DRIP_USD),
      escrowDays: e.ESCROW_TTL_DAYS,
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}

export type LiveNetwork = { chain: Chain; name: string; network: string };

/**
 * The networks payments settle on right now: every active chain with a working adapter. When the
 * environment can't be read, the chains the landing page marks live.
 */
export function liveNetworks(): LiveNetwork[] {
  try {
    const adapters = getAdapters();
    return activeChains()
      .filter(({ chain }) => adapters[chain])
      .map(({ chain, entry }) => ({ chain, name: chainLabel(chain), network: entry.network }));
  } catch {
    return settlesOn
      .filter((c) => c.status === "live")
      .flatMap((c) => {
        const chain = CHAINS.find((id) => chainLabel(id) === c.name);
        return chain ? [{ chain, name: c.name, network: networkName(chain, "testnet") }] : [];
      });
  }
}

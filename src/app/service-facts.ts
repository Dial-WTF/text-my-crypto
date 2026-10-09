import { enabledChains } from "@/lib/chain-status";
import { type Chain, chainLabel } from "@/lib/chains";
import { env, publicEnv } from "@/lib/env";
import { networkName } from "@/lib/ledger";
import { activeChains, getAdapters } from "@/lib/settlement";

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

export type EnabledNetwork = { chain: Chain; name: string; network: string };

/**
 * The networks payments settle on right now: every chain CHAINS switches on with a working adapter. When
 * the adapters can't be built (secrets missing), the chains the public settings switch on.
 */
export function enabledNetworks(): EnabledNetwork[] {
  try {
    const adapters = getAdapters();
    return activeChains()
      .filter(({ chain }) => adapters[chain])
      .map(({ chain, entry }) => ({ chain, name: chainLabel(chain), network: entry.network }));
  } catch {
    const { CHAINS: chains, NETWORK: network } = publicEnv();
    return enabledChains(chains, network).map((chain) => ({ chain, name: chainLabel(chain), network: networkName(chain, network) }));
  }
}

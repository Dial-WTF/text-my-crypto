import type { ReactNode } from "react";
import type { Chain } from "@/lib/chains";
import type { Network } from "@/lib/settlement/registry";
import type { SettlementAdapter } from "@/lib/settlement/types";

/** What every demo gets: the chain, the network running now, and the chain's adapter when it could be built. */
export type DemoProps = {
  chain: Chain;
  network: Network;
  /** "Solana", "Hyperliquid". */
  name: string;
  /** Null where the adapters can't be built (no secrets) or the chain is off: demos that need the module render nothing. */
  adapter: SettlementAdapter | null;
};

/** A read-only, in-browser demo of one chain-native module. Never sends a text or moves money. */
export type Demo = (props: DemoProps) => ReactNode | Promise<ReactNode>;

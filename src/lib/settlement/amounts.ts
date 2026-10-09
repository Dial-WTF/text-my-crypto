import type { Chain } from "@/lib/chains";
import { formatUsd } from "@/lib/money";
import { type Network, REGISTRY } from "./registry";
import { formatZec, usdToZats } from "./zcash";

/** What a chain settles in on a network: "USDC", or Zcash's own coin ("TAZ" on testnet). */
export function assetOf(chain: Chain, network: Network): string {
  const entry = REGISTRY[chain][network];
  return entry?.kind === "zcash" ? entry.asset : "USDC";
}

/**
 * A dollar amount as people should read it on a chain: "$5" where it settles as USDC, and
 * "$5 (0.1 TAZ)" on Zcash, where dollars are only a demo rate and the coin is what moves.
 */
export function money(amount: bigint, chain: Chain, network: Network): string {
  const entry = REGISTRY[chain][network];
  if (entry?.kind !== "zcash" || entry.usdPerZec === null) return formatUsd(amount);
  return `${formatUsd(amount)} (${formatZec(usdToZats(amount, entry.usdPerZec))} ${entry.asset})`;
}

/** True when `money` already named the coin, so a template must not add "USDC". */
export function namesItsCoin(amount: string): boolean {
  return /\((?:[\d.]+) (?:TAZ|ZEC)\)$/.test(amount);
}

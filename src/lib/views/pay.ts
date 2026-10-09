import { enabledChains, ensureWallet } from "@/lib/bot/accounts";
import type { BotDeps } from "@/lib/bot/types";
import type { Chain } from "@/lib/chains";
import type { User } from "@/lib/db/schema";
import { isUsdAmount, usdToBaseUnits } from "@/lib/money";
import { eip681TransferUri, payActionUrl, payByTextBody, smsUri, solanaActionLinks, solanaPayUri } from "@/lib/pay-links";
import { REGISTRY } from "@/lib/settlement/registry";

export type PayChain = {
  chain: Chain;
  network: string;
  address: string;
  token: string;
  /** Opens a wallet app on a filled-in transfer: Solana Pay on Solana, EIP-681 elsewhere. */
  uri: string;
  explorer: string;
  /** Solana only: the same payment as a Solana Action (Blink) any Solana wallet can sign. */
  action?: { url: string; uri: string; blink: string };
};

/** Everything a payer needs, and nothing private: no phone number, no balances. */
export type PayProfile = {
  handle: string;
  name: string;
  url: string;
  amountUsd: string | null;
  note: string | null;
  byText: { to: string; body: string; uri: string };
  chains: PayChain[];
};

export type PayAsk = { amountUsd?: string; note?: string };

/**
 * Cleans what a pay link asks for: a valid dollar amount within the cap, a short one-line note. The
 * note loses control and format characters (bidi overrides, zero-width spaces), which could make a
 * shared link read differently from what it asks for.
 */
export function cleanAsk(deps: Pick<BotDeps, "perTxCap">, raw: { amount?: string | null; note?: string | null }): PayAsk {
  const amount = raw.amount?.trim().replace(/^\$/, "");
  const okAmount = amount && isUsdAmount(amount) && usdToBaseUnits(amount) > 0n && usdToBaseUnits(amount) <= deps.perTxCap;
  const note = raw.note
    ?.replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 60);
  return { ...(okAmount ? { amountUsd: amount } : {}), ...(note ? { note } : {}) };
}

/** The public pay profile for a claimed Dial user. Opens a wallet on any live chain they don't have one on yet. */
export async function payProfile(deps: BotDeps, user: User, ask: PayAsk = {}): Promise<PayProfile> {
  const handle = user.handle ?? "";
  const label = `Dial · @${handle}`;
  const chains: PayChain[] = [];
  for (const [chain, adapter] of enabledChains(deps)) {
    const entry = REGISTRY[chain][deps.network];
    if (!entry) continue;
    const token = entry.kind === "solana" ? entry.mint : entry.token;
    if (!token) continue;
    const { address } = await ensureWallet(deps, user.id, chain, adapter);
    const uri =
      entry.kind === "solana"
        ? solanaPayUri({ address, mint: token, amountUsd: ask.amountUsd, label, message: ask.note })
        : eip681TransferUri({
            token,
            chainId: entry.viem.id,
            address,
            baseUnits: ask.amountUsd ? usdToBaseUnits(ask.amountUsd) : undefined,
          });
    const actionUrl = payActionUrl(deps.appUrl, handle, ask);
    const action = entry.kind === "solana" ? { url: actionUrl, ...solanaActionLinks(actionUrl, deps.network === "testnet") } : null;
    chains.push({ chain, network: entry.network, address, token, uri, explorer: entry.explorerAddress(address), ...(action ? { action } : {}) });
  }
  const body = payByTextBody(handle, ask.amountUsd, ask.note);
  const query = new URLSearchParams({ ...(ask.amountUsd ? { amount: ask.amountUsd } : {}), ...(ask.note ? { note: ask.note } : {}) });
  return {
    handle,
    name: user.name ?? `@${handle}`,
    url: `${deps.appUrl}/@${handle}${query.size ? `?${query}` : ""}`,
    amountUsd: ask.amountUsd ?? null,
    note: ask.note ?? null,
    byText: { to: deps.operatorNumber, body, uri: smsUri(deps.operatorNumber, body) },
    chains,
  };
}

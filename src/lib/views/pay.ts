import { enabledChains, ensureWallet } from "@/lib/bot/accounts";
import type { BotDeps } from "@/lib/bot/types";
import type { Chain } from "@/lib/chains";
import type { User } from "@/lib/db/schema";
import { isUsdAmount, usdToBaseUnits } from "@/lib/money";
import { eip681TransferUri, payByTextBody, smsUri, solanaPayUri, zip321Uri } from "@/lib/pay-links";
import { REGISTRY } from "@/lib/settlement/registry";
import { formatZec, usdToZats } from "@/lib/settlement/zcash";

export type PayChain = {
  chain: Chain;
  network: string;
  address: string;
  token: string;
  /** What lands in the wallet: "USDC", or "TAZ" (testnet ZEC) on Zcash. */
  asset: string;
  /** Said next to the wallet option when the coin isn't dollars, e.g. "Pays 0.1 TAZ: testnet ZEC at a demo rate of $50 per coin." */
  assetNote: string | null;
  /** Opens a wallet app on a filled-in transfer: Solana Pay on Solana, ZIP 321 on Zcash, EIP-681 elsewhere. */
  uri: string;
  explorer: string;
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
    const token = entry.kind === "solana" ? entry.mint : entry.kind === "zcash" ? entry.asset : entry.token;
    if (!token) continue;
    const { address } = await ensureWallet(deps, user.id, chain, adapter);
    const baseUnits = ask.amountUsd ? usdToBaseUnits(ask.amountUsd) : undefined;
    let uri: string;
    let assetNote: string | null = null;
    if (entry.kind === "solana") {
      uri = solanaPayUri({ address, mint: token, amountUsd: ask.amountUsd, label, message: ask.note });
    } else if (entry.kind === "zcash") {
      const amountZec = baseUnits !== undefined && entry.usdPerZec ? formatZec(usdToZats(baseUnits, entry.usdPerZec)) : undefined;
      uri = zip321Uri({ address, amountZec, label, message: ask.note });
      const rate = `testnet ZEC at a demo rate of $${entry.usdPerZec} per coin`;
      assetNote = amountZec ? `Pays ${amountZec} ${entry.asset}: ${rate}.` : `${entry.asset} is ${rate}.`;
    } else {
      uri = eip681TransferUri({ token, chainId: entry.viem.id, address, baseUnits });
    }
    const asset = entry.kind === "zcash" ? entry.asset : "USDC";
    chains.push({ chain, network: entry.network, address, token, asset, assetNote, uri, explorer: entry.explorerAddress(address) });
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

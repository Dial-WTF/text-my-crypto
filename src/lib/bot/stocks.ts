import { type Chain, chainLabel } from "@/lib/chains";
import type { Intent, User } from "@/lib/db/schema";
import { isClaimed } from "@/lib/identity";
import { createIntent, issueCode, newIntentId } from "@/lib/intents";
import type { MoneyCommand } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import { stockReplies } from "@/lib/operator/stock-replies";
import type { Asset, AssetTransfers } from "@/lib/settlement/capabilities";
import { REGISTRY } from "@/lib/settlement/registry";
import type { SettlementAdapter } from "@/lib/settlement/types";
import { seal } from "@/lib/secretbox";
import { formatAmount, formatShares, isShareAmount, sharesToUnits, stockForToken } from "@/lib/stocks";
import { ensureWallet } from "./accounts";
import type { MoneyError, Prepared } from "./money";
import type { BotDeps } from "./types";

const fail = (code: MoneyError["code"], message: string): Prepared => ({ ok: false, error: { code, message } });

type StockChain = { chain: Chain; adapter: SettlementAdapter; assets: AssetTransfers; network: string; stocks: Asset[] };

/** Every enabled chain carrying the `assets` module, with its asset list and what this network is called. */
function assetChains(deps: BotDeps): StockChain[] {
  return (Object.entries(deps.adapters) as Array<[Chain, SettlementAdapter | undefined]>).flatMap(([chain, adapter]) => {
    const assets = adapter?.assets;
    if (!adapter || !assets) return [];
    return [{ chain, adapter, assets, network: REGISTRY[chain][deps.network]?.network ?? chainLabel(chain), stocks: assets.list() }];
  });
}

/**
 * The chain to send `symbol` on: the one whose `assets` list has it (the named chain first, if it does), never
 * a chain picked by name. Without a symbol, the first chain carrying the module, for "stocks".
 */
function stockChain(deps: BotDeps, symbol?: string, preferred?: Chain): StockChain | null {
  const chains = assetChains(deps).sort((a, b) => Number(b.chain === preferred) - Number(a.chain === preferred));
  if (!symbol) return chains[0] ?? null;
  return chains.find((c) => c.stocks.some((s) => s.symbol === symbol)) ?? null;
}

export type StockChecked =
  | { ok: true; chain: Chain; adapter: SettlementAdapter; assets: AssetTransfers; asset: Asset; amount: bigint; token: string }
  | { ok: false; error: MoneyError };

/**
 * The checks a stock send needs before any lookup: the ticker is one of the chain's stock tokens, the chain
 * is on, and the share amount is well-formed. No dollar caps: testnet stock tokens have no price to cap by.
 */
export function checkStock(deps: BotDeps, cmd: Pick<MoneyCommand, "amountUsd" | "chain" | "asset">): StockChecked {
  const err = (code: MoneyError["code"], message: string): StockChecked => ({ ok: false, error: { code, message } });
  const symbol = (cmd.asset ?? "").toUpperCase();
  const home = stockChain(deps, symbol, cmd.chain);
  if (!home) {
    const any = stockChain(deps);
    if (!any) return err("chain_unavailable", stockReplies.unavailable());
    return err("unknown_asset", stockReplies.unknownStock(symbol, any.network, any.stocks.map((s) => s.symbol)));
  }
  if (cmd.chain && cmd.chain !== home.chain) return err("chain_unavailable", stockReplies.otherChain(chainLabel(cmd.chain), home.network));
  const asset = home.stocks.find((s) => s.symbol === symbol);
  if (!asset) return err("unknown_asset", stockReplies.unknownStock(symbol, home.network, home.stocks.map((s) => s.symbol)));
  const amount = isShareAmount(cmd.amountUsd) ? sharesToUnits(cmd.amountUsd) : 0n;
  if (amount <= 0n) return err("bad_amount", stockReplies.badShares());
  return { ok: true, chain: home.chain, adapter: home.adapter, assets: home.assets, asset, amount, token: asset.address };
}

/**
 * A stock send, from validation to the pending PaymentIntent and its code. Like a dollar send: the sender
 * approves with a texted code, and someone not on Dial yet gets it held for them. Escrow programs hold
 * the stablecoin only, so a stock always waits in a server-held escrow wallet. Texts nobody.
 */
export async function createStockSend(deps: BotDeps, user: User, cmd: MoneyCommand, other: User): Promise<Prepared> {
  const checked = checkStock(deps, cmd);
  if (!checked.ok) return checked;
  const { chain, adapter, assets, asset, amount } = checked;
  if (other.id === user.id) return fail("self", replies.selfSend());

  const mine = await ensureWallet(deps, user.id, chain, adapter);
  const balance = await assets.balanceOf(mine.address, asset);
  if (balance < amount) {
    const network = REGISTRY[chain][deps.network]?.network ?? chainLabel(chain);
    return fail("insufficient", stockReplies.insufficient(`${formatShares(balance)} ${asset.symbol}`, network, mine.address));
  }

  let recipientAddress: string;
  let escrowSecretEnc: string | null = null;
  if (isClaimed(other)) {
    recipientAddress = (await ensureWallet(deps, other.id, chain, adapter)).address;
  } else {
    const escrow = await adapter.createWallet();
    recipientAddress = escrow.address;
    escrowSecretEnc = await seal(escrow.secret, deps.walletKey);
  }
  const intent = await createIntent(
    deps.db,
    {
      id: newIntentId(),
      kind: "send",
      createdBy: user.id,
      senderId: user.id,
      recipientId: other.id,
      chain,
      token: asset.address,
      recipientAddress,
      amount,
      note: cmd.note ?? null,
      escrowSecretEnc,
    },
    deps.now(),
  );
  // No price, so no passkey threshold to cross: the texted code approves it.
  const code = await issueCode(deps.db, intent.id);
  return { ok: true, prepared: { intent, counterparty: other, code, approveUrl: `${deps.appUrl}/a/${intent.id}` } };
}

/** "Send 0.1 TSLA to Alex on Robinhood Chain?" or the dollar version, for whichever this send moves. */
export function confirmSendReply(i: Intent, who: string, code: string | null, link: string): string {
  const confirm = stockForToken(i.chain, i.token) ? stockReplies.confirmSend : replies.confirmSend;
  return confirm(formatAmount(i), who, chainLabel(i.chain), i.note, code, link);
}

export type StockHolding = { symbol: string; name: string; token: string; shares: string };
export type StockBalances = { chain: Chain; network: string; address: string; holdings: StockHolding[]; symbols: string[] };

/**
 * The user's asset balances on every chain carrying the `assets` module. Opens their wallet on each if they
 * have none, so they get an address to fund.
 */
export async function stockBalances(deps: BotDeps, user: User): Promise<StockBalances[]> {
  const out: StockBalances[] = [];
  for (const home of assetChains(deps)) {
    const wallet = await ensureWallet(deps, user.id, home.chain, home.adapter);
    const holdings: StockHolding[] = [];
    for (const stock of home.stocks) {
      const units = await home.assets.balanceOf(wallet.address, stock);
      if (units > 0n) holdings.push({ symbol: stock.symbol, name: stock.name, token: stock.address, shares: formatShares(units) });
    }
    out.push({ chain: home.chain, network: home.network, address: wallet.address, holdings, symbols: home.stocks.map((s) => s.symbol) });
  }
  return out;
}

/** "stocks" / "portfolio": what they hold, or where to get test stock tokens. */
export async function stocksReply(deps: BotDeps, user: User): Promise<string> {
  const chains = await stockBalances(deps, user);
  const held = chains.filter((b) => b.holdings.length > 0);
  if (held.length > 0) {
    return stockReplies.portfolio(
      held.map((b) => b.network).join(" and "),
      held.flatMap((b) => b.holdings.map((h) => `${h.shares} ${h.symbol}`)),
    );
  }
  const first = chains[0];
  return first ? stockReplies.noStocks(first.network, first.symbols, first.address) : stockReplies.unavailable();
}

/** "send @alex $5 of TSLA": dollar amounts need a price, and testnet stock tokens have none. */
export function stockPricedReply(deps: BotDeps, symbol: string): string {
  const home = stockChain(deps, symbol) ?? stockChain(deps);
  if (!home) return stockReplies.unavailable();
  if (!home.stocks.some((s) => s.symbol === symbol)) {
    return stockReplies.unknownStock(symbol, home.network, home.stocks.map((s) => s.symbol));
  }
  return stockReplies.noPrice(symbol, home.network);
}

import { BRAND, NEWCOMER_FOOTER } from "./replies";

const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");
const ROBINHOOD_FAUCET = "faucet.testnet.chain.robinhood.com";

/**
 * Replies only stock tokens need. Everywhere else a stock amount ("0.1 TSLA") goes through the usual replies,
 * which add "USDC" only to plain dollars (namesItsCoin). `network` is the registry's name, like "Robinhood Chain testnet".
 */
export const stockReplies = {
  receivedUnclaimed: (amount: string, from: string, note: string | null) =>
    `You got money! ${from} sent you ${amount} (a test stock token)${forNote(note)} using ${BRAND}, the revolutionary new way to send money by text. Reply YES to get it. ${NEWCOMER_FOOTER}`,
  /** Testnet stock tokens have no price feed, so a dollar amount can't be turned into shares. */
  noPrice: (symbol: string, network: string) =>
    `${network} has no price for ${symbol}, so I can't send a dollar amount of it. Send shares instead, like "send @alex 0.1 ${symbol}".`,
  unknownStock: (symbol: string, network: string, symbols: string[]) =>
    `${symbol} isn't a stock token on ${network}. You can send ${symbols.join(", ")}.`,
  otherChain: (chain: string, network: string) => `Stock tokens live on ${network}, not ${chain}. Leave off "on ${chain}".`,
  unavailable: () => `Stock tokens need Robinhood Chain, which isn't switched on yet.`,
  badShares: () => `Share amounts can be from 0.000001 to 999999, like 0.1 or 2.`,
  insufficient: (balance: string, network: string, address: string) =>
    `You have ${balance} on ${network}, not enough for that one. Free test stock tokens: ${ROBINHOOD_FAUCET} to ${address}`,
  portfolio: (network: string, holdings: string[]) =>
    `Your stock tokens on ${network}: ${holdings.join(", ")}. Send some: "send @name 0.1 ${holdings[0]?.split(" ")[1] ?? "TSLA"}". Testnet has no prices.`,
  noStocks: (network: string, symbols: string[], address: string) =>
    `No stock tokens yet on ${network}. Get ${symbols.join(", ")} free at ${ROBINHOOD_FAUCET} for your address ${address}`,
} as const;

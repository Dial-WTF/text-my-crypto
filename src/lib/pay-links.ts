/**
 * Payment request links that wallets open straight into a filled-in transfer. Pure: no network.
 * Solana: Solana Pay transfer requests. Tempo and EVM chains: EIP-681 token transfers. Zcash: ZIP 321.
 */

const enc = encodeURIComponent;

/** solana:<recipient>?amount=…&spl-token=<mint>&label=…&message=… (Solana Pay). Amount is in dollars. */
export function solanaPayUri(args: { address: string; mint: string; amountUsd?: string; label: string; message?: string }): string {
  const params = [
    args.amountUsd ? `amount=${enc(args.amountUsd)}` : null,
    `spl-token=${enc(args.mint)}`,
    `label=${enc(args.label)}`,
    args.message ? `message=${enc(args.message)}` : null,
  ].filter(Boolean);
  return `solana:${args.address}?${params.join("&")}`;
}

/** The pay action (Solana Action) URL for a handle, carrying any preset amount and note. */
export function payActionUrl(appUrl: string, handle: string, ask: { amountUsd?: string; note?: string } = {}): string {
  const q = new URLSearchParams({ ...(ask.amountUsd ? { amount: ask.amountUsd } : {}), ...(ask.note ? { note: ask.note } : {}) });
  return `${appUrl}/api/actions/pay/${handle}${q.size ? `?${q}` : ""}`;
}

/**
 * A Solana Action (Blink) for an action URL: the solana-action: URI wallets and Blink clients open, and
 * a dial.to page that renders it anywhere. On testnet dial.to is told to use devnet.
 */
export function solanaActionLinks(actionUrl: string, testnet: boolean): { uri: string; blink: string } {
  const uri = `solana-action:${actionUrl}`;
  return { uri, blink: `https://dial.to/?action=${enc(uri)}${testnet ? "&cluster=devnet" : ""}` };
}

/** ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<base units> (EIP-681). */
export function eip681TransferUri(args: { token: string; chainId: number; address: string; baseUnits?: bigint }): string {
  const amount = args.baseUnits !== undefined ? `&uint256=${args.baseUnits}` : "";
  return `ethereum:${args.token}@${args.chainId}/transfer?address=${args.address}${amount}`;
}

/** zcash:<address>?amount=<ZEC>&label=…&message=… (ZIP 321). Amount is in coins, not dollars. */
export function zip321Uri(args: { address: string; amountZec?: string; label: string; message?: string }): string {
  const params = [
    args.amountZec ? `amount=${args.amountZec}` : null,
    `label=${enc(args.label)}`,
    args.message ? `message=${enc(args.message)}` : null,
  ].filter(Boolean);
  return `zcash:${args.address}?${params.join("&")}`;
}

/** What someone texts the operator to pay this handle, e.g. "send @alex $5 for pizza". */
export function payByTextBody(handle: string, amountUsd?: string, note?: string): string {
  if (!amountUsd) return `send @${handle} $`;
  return `send @${handle} $${amountUsd}${note ? ` for ${note}` : ""}`;
}

export function smsUri(number: string, body: string): string {
  return `sms:${number}?&body=${enc(body)}`;
}

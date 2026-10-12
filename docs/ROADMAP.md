# Roadmap

Text money to anyone. The Dial operator ships in tranches; each one is usable on its own.

## Tranche 1 · SMS-first payments (now)

- Text the operator from any phone: signup by replying with a name, then send, request, invoice, receive, withdraw, reclaim.
- Every money movement is confirmed by a one-time code texted to the phone (6 digits, bound to one payment, 10 minutes, 5 tries) or by a passkey.
- Unknown names: the operator asks for the number and remembers it as a contact.
- Recipients not on Dial: funds wait in escrow; only the holder of that phone number can claim (by replying from it). Unclaimed escrows come back to the sender after 7 days via `reclaim`. On Solana the escrow is now an on-chain program (Tranche 3).
- Passkey upgrade from a link: payments over $20 then require the passkey.
- Settlement on Solana devnet (USDC). Wallets are server-held and encrypted; `withdraw all to <address>` exits to self-custody at any time.
- Language: TypeScript (Next.js on Cloudflare Workers via OpenNext, D1, Payphone for SMS).

## Tranche 2 · Self-custody for passkey accounts

- **Tempo:** passkey accounts are native; the passkey becomes the account's on-chain signer, so Dial cannot move those funds.
- **Solana:** a smart wallet whose authority is the user's passkey (secp256r1 verification on-chain).
- Text-only accounts stay custodial with low limits, the way mobile money works today.
- Language: TypeScript (viem / Tempo SDK, `@solana/kit`).

## Tranche 3 · On-chain escrow

- **Shipped on Solana devnet:** the `dial_escrow` program (`solana/`) holds unclaimed payments. After expiry anyone can refund to the sender, without Dial.
- Claims require an attestation that the claimer controls the phone number. Dial is the first attestor (one key per escrow today); next, the program accepts any configured attestor set (k-of-n).
- Same contract on EVM chains (Tempo, Base) if we take escrow on-chain there too.
- Languages: Rust (Anchor program), Solidity (EVM escrow).

## Proving phone ownership without trusting Dial

There is no fully trustless proof of a phone number today: SMS is unsigned, and the SIM's secret key is only used to authenticate with the carrier. The options, from most practical to most decentralized:

1. **Carrier network checks** (GSMA Open Gateway / CAMARA, via aggregators): *Number Verification* confirms the device's data session belongs to the number; *SIM Swap* reports the last SIM change, so approvals can be refused right after a swap. Trust moves from Dial to the carrier.
2. **Carrier attestations verified on-chain:** the escrow program checks a signed verification result instead of Dial's word; several attestors can be required.
3. **zkTLS** (Reclaim, Opacity, TLSNotary): the user proves their carrier account shows the number, trusting only the carrier's TLS endpoint.

## More chains

Each chain carries the capability modules its network makes possible (see [CAPABILITIES.md](CAPABILITIES.md)).

| Chain | Status (testnet) | Chain-native feature |
| --- | --- | --- |
| Solana | Switched on (devnet USDC) | `dial_escrow` program; pay links are Blinks |
| Tempo | Switched on (AlphaUSD) | Split payments in one batched transaction |
| Ethereum | Switched on (Sepolia USDC) | ENS names |
| Base | Switched on (Base Sepolia USDC) | Basenames |
| Arbitrum | Switched on (Arbitrum Sepolia USDC) | Stylus escrow contract (in progress) |
| Hyperliquid | Switched on (HyperEVM testnet USDC) | Transfers into HyperCore (in progress) |
| Robinhood Chain | Switched on (Dial Test USD) | Stock token gifts (in progress) |
| Zcash | Built, off until its wallet service is deployed | Shielded sends, payment id in the encrypted memo |

## Agents

- MCP server at `/api/mcp` and an installable skill, so any AI agent can send, request or invoice anyone with a phone number. The person still approves every payment from a text.

## Revenue and the network view

- **A small payment fee.** 25 basis points on sends, paid by the sender on top of the amount and shown in the confirm text ("$10 + $0.03 fee"). It settles in the same transaction where the chain allows it (a second instruction on Solana, a second call in Tempo's batch) and goes to the chain's treasury, which pays for signup drops and gas. It runs on testnet first, with play money, before any real fee.
- **/network.** A live view of the operator: chains as hubs, payments moving between handles as they settle, and fees collected per chain. People are shown by handle or not at all, never by number or location.

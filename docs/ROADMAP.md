# Roadmap

Text money to anyone. The Dial operator ships in tranches; each one is usable on its own.

## Tranche 1 · SMS-first payments (now)

- Text the operator from any phone: signup by replying with a name, then send, request, invoice, receive, withdraw, reclaim.
- Every money movement is confirmed by a one-time code texted to the phone (6 digits, bound to one payment, 10 minutes, 5 tries) or by a passkey.
- Unknown names: the operator asks for the number and remembers it as a contact.
- Recipients not on Dial: funds move into a per-payment escrow address; only the holder of that phone number can claim (code texted to that number). Unclaimed escrows come back to the sender after 7 days via `reclaim`.
- Passkey upgrade from a link: payments over $20 then require the passkey.
- Settlement on Solana devnet (USDC). Wallets are server-held and encrypted; `withdraw all to <address>` exits to self-custody at any time.
- Language: TypeScript (Next.js on Cloudflare Workers via OpenNext, D1, Payphone for SMS).

## Tranche 2 · Self-custody for passkey accounts

- **Tempo:** passkey accounts are native; the passkey becomes the account's on-chain signer, so Dial cannot move those funds.
- **Solana:** a smart wallet whose authority is the user's passkey (secp256r1 verification on-chain).
- Text-only accounts stay custodial with low limits, the way mobile money works today.
- Language: TypeScript (viem / Tempo SDK, `@solana/kit`).

## Tranche 3 · On-chain escrow

- A Solana program holds unclaimed payments. The sender can always refund after expiry without Dial.
- Claims require an attestation that the claimer controls the phone number. Dial is the first attestor; the program accepts any configured attestor set (k-of-n).
- Same contract on EVM chains (Tempo, Base) if we take escrow on-chain there too.
- Languages: Rust (Anchor program), Solidity (EVM escrow).

## Proving phone ownership without trusting Dial

There is no fully trustless proof of a phone number today: SMS is unsigned, and the SIM's secret key is only used to authenticate with the carrier. The options, from most practical to most decentralized:

1. **Carrier network checks** (GSMA Open Gateway / CAMARA, via aggregators): *Number Verification* confirms the device's data session belongs to the number; *SIM Swap* reports the last SIM change, so approvals can be refused right after a swap. Trust moves from Dial to the carrier.
2. **Carrier attestations verified on-chain:** the escrow program checks a signed verification result instead of Dial's word; several attestors can be required.
3. **zkTLS** (Reclaim, Opacity, TLSNotary): the user proves their carrier account shows the number, trusting only the carrier's TLS endpoint.
4. **Keys on the SIM:** a SIM or eSIM applet that holds a signing key. Payphone already provisions eSIMs, so this is a long-term path for numbers Dial issues.

## More chains

| Chain | Status | Language |
| --- | --- | --- |
| Solana | Tranche 1 (devnet USDC) | TypeScript; Rust for the escrow program |
| Tempo | Next (AlphaUSD, passkey accounts) | TypeScript; Solidity if escrow goes on-chain |
| Base | Next (USDC on Base Sepolia) | TypeScript; Solidity if escrow goes on-chain |
| Zcash | Stretch (shielded sends, memo = payment id) | Rust wallet service in a Cloudflare Container |

## Agents

- MCP server at `/api/mcp` and an installable skill, so any AI agent can send, request or invoice anyone with a phone number. The person still approves every payment from a text.

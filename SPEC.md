# Text My Crypto — Spec

Text a payment to anyone. Text the Dial number, it says hi, notices when you want to send money, you approve with a passkey, it settles on-chain, and you get a receipt by text.

This is Text My Bits (2020, Rootstock, SMS bearer codes) rebuilt: same idea of money over plain SMS, but with real identities instead of hashed phone codes, passkey approval instead of a 4-character code, and settlement on modern chains. The voucher idea survives as the claim link for people who don't have an account yet.

> "send jeremy $10" → confirm link → passkey → 10 USDC lands → receipt with tx hash

Target: Colosseum Crypto World's Fair. Submission closes **2026-10-12 11:59pm PDT**. One submission, multiple chains integrated so it's eligible across ecosystem tracks plus the general pool. **Main demo is Solana.** Chain order: Solana → Tempo → Base → Zcash (stretch).

Bot number: **+1 806-607-1387** (Payphone line, owned by our API account).

## Goals

- A live demo where a real SMS moves real testnet stablecoins and a verifiable receipt comes back in under ~30s.
- No wallet addresses anywhere in the sender's flow. Recipients are names or phone numbers.
- Approval binds the exact payment. A replayed or edited approval never moves money twice.
- Same flow on every chain. The chain is a settlement detail, not a different product.

## Non-goals (for the hackathon)

- Mainnet funds, fiat on/off-ramp, KYC.
- Payment requests, invoices, thread unlocks (pitch-deck roadmap only).
- Dial chat / Matrix channel (SMS only; channel interface leaves room).
- Native mobile app.

## User flows

### 1. Start from a text (single landing page)
1. The site is one page: "Text here to start", the Dial operator phone number, and a QR code that opens the phone's SMS app with an `sms:` link prefilled (`sms:+1XXXXXXXXXX?&body=hi`). Below it, a looping SMS-thread mock of the full flow.
2. The first text from an unknown number gets a reply with a one-time signup link (`/s/<token>`, 15 min). The link is delivered to that phone, so opening it proves control of the number. No separate OTP step.
3. Signup page: create a passkey, pick a handle ("jeremy"). A server-held wallet is created per chain, and the passkey gates every spend from it. Testnet funds are dropped automatically on signup.
4. Bot texts: `You're in, jeremy. Try: send alex $5`.

### 2. Send (SMS)
1. User texts the Dial operator number: `send jeremy $10`.
2. Payphone forwards the inbound SMS to our webhook. We look up the sender by phone. Unknown sender → flow 1.
3. The Dial operator reads the message. Small talk gets a short friendly reply (first contact: `hi, I'm the Dial operator. I can help you text your crypto. Try "send jeremy $10".`). The bot persona is **the Dial operator** everywhere. When it detects a payment, it parses to `{ action: "send", amount: "10", asset: "USD", recipient: "jeremy", chain?: "solana" }`.
4. Deterministic validation: amount > 0 and ≤ per-tx cap, recipient resolves, sender has balance. Any failure → plain-English SMS reply, no intent created.
5. Server creates a **PaymentIntent** (immutable: sender, recipient address, chain, token, amount in base units, nonce, expiresAt = now + 10 min) and texts back:
   `Send 10 USDC to jeremy on Solana? Approve: https://<host>/a/<intentId>`
6. Approval page shows the exact intent. User approves with passkey. The WebAuthn challenge is the hash of the canonical intent, so the signature covers recipient, amount, chain, token, nonce and expiry.
7. Server verifies the assertion, atomically flips intent `pending → approved` (single-use), hands it to the settlement adapter.
8. Adapter submits and waits for confirmation. Intent → `settled` with tx hash.
9. Sender gets: `Sent 10 USDC to jeremy. Solana tx 5Hx…9k <explorer link>`. Recipient gets: `jeremy, you received 10 USDC from alex.`

### 3. Unregistered recipient (claim link)
If the recipient is a phone number with no account, funds go to a per-intent escrow held by the server wallet on that chain, and the recipient gets an SMS claim link. Claiming = onboarding, then the escrow pays out. Unclaimed after 7 days → refund. This is the growth loop for the pitch. **Stretch goal**: build after all three chains settle end to end.

## Architecture

```
Payphone line ──► /api/sms/[secret] (secret-path webhook)
                   │
                   ▼
           the Dial operator intent parser  (LLM → typed object; never sees keys)
                   │
                   ▼
           Validator + Identity resolver (Postgres directory)
                   │
                   ▼
           PaymentIntent store ──► SMS with approval link
                                          │
                     /a/[intentId] passkey approval page
                                          │
                                          ▼
                   Approve (verify WebAuthn, single-use flip)
                                          │
                                          ▼
              SettlementAdapter.settle(intent) → { txHash, explorerUrl }
                 ├─ solana  (SPL USDC transfer, devnet, treasury pays fees)
                 ├─ tempo   (TIP-20 transfer w/ memo = intentId)
                 ├─ base    (ERC-20 USDC transfer, Base Sepolia)
                 └─ zcash   (shielded send via wallet sidecar, stretch)
                                          │
                                          ▼
                              Receipt SMS to both parties
```

### Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `channels/sms` | Accept Payphone inbound forwards (`{ phoneNumber, sender, message, date }`) on a secret path, normalize to `{ from, body }`, send outbound via Payphone `POST /api/v1/sms/send` with `from` = our line | Payphone.wtf |
| `agent/parse` | Text → `ParsedCommand` (zod schema) via AI SDK structured output through Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Also handles `balance`, `help` | AI SDK |
| `identity` | Users, handles, phones, per-chain addresses; resolve `"jeremy"` or `+1555…` → `Recipient` | DB |
| `intents` | Create, fetch, canonical hash, state machine `pending → approved → settling → settled \| failed \| expired` | DB |
| `auth/passkey` | WebAuthn registration and intent-bound assertions (SimpleWebAuthn) | DB |
| `settlement/*` | `SettlementAdapter` interface + one adapter per chain | chain SDKs |
| `app/*` | Onboarding, approval page, activity/receipt page, landing page | everything above |

`SettlementAdapter`:
```ts
interface SettlementAdapter {
  chain: "solana" | "tempo" | "base" | "zcash";
  getBalance(address: string): Promise<bigint>;
  settle(intent: ApprovedIntent): Promise<{ txHash: string; explorerUrl: string }>;
}
```

### Hosting
- Next.js 16 on **Cloudflare Workers via OpenNext** (`@opennextjs/cloudflare`), Workers Paid plan. No `runtime = "edge"`; background work after a webhook response uses `getCloudflareContext().ctx.waitUntil`.
- Secrets via `wrangler secret put`; local dev reads `.dev.vars` / `.env.local`.
- Postgres on **Neon** via `@neondatabase/serverless` HTTP driver (fetch-based, Worker-friendly). Tests use PGlite.
- Everything on the request path uses WebCrypto and `fetch` (no Node-only crypto, no WebSocket subscriptions). Solana confirmation polls `getSignatureStatuses`.
- **Cloudflare Containers** only if needed: the Zcash wallet sidecar.

### Data model (Postgres)
- `users(id, phone_e164 unique, handle unique, default_chain, created_at)`
- `wallets(user_id, chain, address, custody: "passkey" | "server", encrypted_secret null)`
- `passkeys(id, user_id, credential_id, public_key, counter)`
- `intents(id, sender_id, recipient_user_id null, recipient_phone null, chain, token, amount_base_units, nonce, expires_at, status, tx_hash null, error null, created_at)`
- `signup_tokens(token, phone_e164, expires_at, used_at null)`
- `sms_log(id, direction, phone, body, intent_id null, created_at)` (demo activity feed + inbound dedupe)

### Chains
- **Solana** (primary, main demo): devnet, `@solana/kit` + `@solana-program/token`, Circle devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals). Server-held keypair per user, passkey-gated. A treasury wallet pays all SOL fees and ATA rent, so users never hold SOL, and drips test USDC to new users.
- **Tempo**: Moderato testnet (chain 42431), `viem/tempo` client, AlphaUSD (`0x20c0000000000000000000000000000000000001`, 6 decimals) as transfer and fee token, `token.transferSync` with memo = intent id, faucet `fundSync` on signup. Verify the Transfer event recipient, since blocked transfers can succeed at the tx level.
- **Base**: Base Sepolia, viem, USDC test token. Server-held key per user, passkey-gated.
- **Zcash** (stretch): testnet, shielded send with the intent id in the encrypted memo. Needs a light-client wallet process (e.g. zingo-cli against a testnet lightwalletd) in a Cloudflare Container, called by the app over an authenticated HTTP API. Built only after Solana and Tempo settle end to end.

Server-held secrets are encrypted at rest with a key from env. The pitch says plainly that hackathon wallets are server-held and passkey-gated on every chain, with a smart-account roadmap for the latter.

## Security rules
- Payphone's per-line inbound forward is **not signed**, so the webhook lives at an unguessable secret path (`/api/sms/<32+ random bytes>`), rotated if leaked. A forged inbound can at most create a pending intent or trigger a reply to the real phone owner. It can never move money, because every spend needs the sender's passkey. Dedupe inbound on `(sender, date, message)`.
- Signup tokens are single-use, 15 min, delivered only by SMS to the number they bind.
- LLM output is untrusted input: schema-validated, then re-validated against DB facts. The LLM cannot pick addresses, only names.
- Approval signature covers the canonical intent hash. Intent status flips with a conditional update (`WHERE status = 'pending' AND expires_at > now()`), so double-submit settles once.
- Per-tx cap ($50) and per-day cap ($200) on testnet.
- Approval links are unguessable ids, expire in 10 minutes, and need the passkey anyway.
- No secrets in client bundles or logs.

## Error handling
Every failure ends in an SMS the user can act on: unknown recipient ("I don't know jeremy. Text their number instead?"), insufficient balance (show balance + faucet link), expired approval ("That link expired. Text it again."), chain failure (intent → `failed`, error stored, "Payment didn't go through, no funds moved").

## Design system — "Receipt"
Custom, not a component-kit default. Payments end in a receipt, so the UI is built from receipts.
- Thermal-receipt cards: off-white paper on near-black, perforated top/bottom edges, monospace line items, dotted leaders between label and value.
- Type: one grotesk for UI, one monospace for every number, address and hash. Big tabular-figure amounts.
- One signal accent for "confirmed" states, used sparingly. Status shown as stamped labels (PENDING / APPROVED / SETTLED).
- Motion: the receipt prints (slides out line by line) when a payment settles.
- Landing page is a single screen: the number, the QR code printed as a receipt line item, the SMS-thread mock beside it. Doubles as the opening shot of the demo video.
- Tokens on `:root`, light and dark, Tailwind v4, built in-house primitives (Button, Receipt, Stamp, Field, PhoneThread).

## Testing
- Unit: parser fixtures (20+ phrasings incl. junk), canonical intent hash, state machine transitions, validator caps.
- Integration: settlement adapters against each testnet behind an env flag.
- E2E smoke: simulated Payphone inbound POST → intent → approval (virtual authenticator in Playwright) → settled on Solana devnet.

## Submission checklist
- Public GitHub repo, README with architecture and how to run.
- 2–3 min pitch video, ≤3 min demo video (real phone, real SMS, explorer link on screen).
- Form: chains integrated (Solana, Tempo, Base, Zcash if shipped), go-to-market (Dial identities + claim-link growth loop), prior work disclosure: this repo starts at the hackathon; SMS runs on Payphone.wtf, our pre-existing SMS platform, used as an external API (no code copied).
- Open question to confirm in Colosseum Discord: can one project place in multiple ecosystem tracks?

## Schedule
| Day | Deliverable |
|---|---|
| Oct 9 | Scaffold, landing page + QR, DB, Payphone webhook + reply, the Dial operator conversation + parser, identity, intents, Solana adapter. Text → settled on Solana devnet (approval stubbed). |
| Oct 10 | Passkey onboarding + intent-bound approval. Tempo adapter. Receipt UI. |
| Oct 11 | Base adapter, Zcash sidecar if green, demo seed data, record both videos. |
| Oct 12 | Buffer, claim-link stretch if green, submit before 11:59pm PDT. |

# Dial operator

Text money to anyone. Text **+1 806 607 1387**, say hi, and the Dial operator handles the rest: send, request, invoice, receive and withdraw USDC by plain SMS. No app, no wallet address. Works on any phone.

Live: https://text-my-crypto.raspy-thunder-20d2.workers.dev

```
you: hi
op:  hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?
you: alex
you: send jeremy $10 for pizza
op:  What's jeremy's number?
you: (806) 555 0142
op:  Send $10 USDC to jeremy (pizza) on Solana? Reply 482913 to confirm.
you: 482913
op:  Sent $10 to jeremy. They have 7 days to claim it.
```

## How it works

```
SMS ──► Payphone line ──► /api/sms/<secret> (Cloudflare Worker)
                              │
                 Dial operator: strict grammar first, language model for loose phrasing
                              │
                 Validation against the ledger: contacts, balances, limits
                              │
                 PaymentIntent (amount, recipient, chain, nonce, expiry), hashed
                              │
        approval: one-time code texted to the payer ── or ── passkey over the intent hash
                              │
                 Settlement adapter ──► Solana devnet USDC (memo = intent id)
                              │
                 Receipts by SMS to both people, with the explorer link
```

- **Any phone.** Signup is replying with a name. Every money movement is confirmed with a 6-digit code texted to the payer (bound to that one payment, 10 minutes, 5 tries). A forged inbound message can't confirm anything because the code only goes to the real phone.
- **Smartphone upgrade.** Text `upgrade` to add a passkey. Payments over $20 then need it; the WebAuthn challenge is the payment's hash.
- **Paying someone new.** Their phone number is enough. Funds wait in a per-payment escrow address; only the holder of that number can claim (code texted to it). Unclaimed escrows come back with `reclaim` after 7 days.
- **Exit anytime.** `withdraw all to <address>`.

Names work like an operator's switchboard: reply with any name ("J. P. Meyer, crypto anarchist" becomes J. P. Meyer, `@jpmeyer`), find people with `411 <name>`, and pay a name: your contacts first, then the directory (one match connects, several ask you to pick, none asks for a number).

Commands: `send jeremy $10`, `411 jeremy`, `call me <name>`, `whoami`, `send $5 to +1 555 123 4567`, `request $25 from adam for pizza`, `invoice sam $200 for logo design`, `balance`, `receive`, `withdraw $10 to <address>`, `reclaim`, `no` (decline a request), `upgrade`, `help`.

## Stack

Next.js 16 on Cloudflare Workers (OpenNext) · D1 · Drizzle · `@solana/kit` · SimpleWebAuthn · AI SDK · Payphone for SMS. TypeScript throughout; Rust for the on-chain escrow program in tranche 3. See [docs/ROADMAP.md](docs/ROADMAP.md).

The UI is a small skinnable kit in `src/ui`: role tokens in `theme/tokens.css`, one file per theme in `theme/themes/` (dark, light, matrix), single-purpose primitives and patterns built only on those tokens.

## Run locally

```bash
pnpm install
node scripts/gen-secrets.mjs >> .env.local   # webhook secret, wallet key, treasury seed
pnpm db:migrate:local
pnpm dev --port 3100
node --env-file=.env.local scripts/sim.mjs +15550001111 "hi"
```

Local runs use `SMS_MODE=log`: replies are printed, never sent. `pnpm dev` handles inbound texts inline because `next dev` has no queue consumer; `pnpm run preview` runs the real worker (`worker.ts`) with a local queue, so it exercises the webhook → queue → consumer path. Preview reads secrets from `.dev.vars`. Tests use an in-memory SMS stub and SQLite (`pnpm test`); `SOLANA_INT=1 pnpm test` also runs the devnet settlement tests.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`: checks, D1 migrations, then `opennextjs-cloudflare deploy`. It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Runtime secrets (`PAYPHONE_API_KEY`, `SMS_WEBHOOK_SECRET`, `WALLET_ENCRYPTION_KEY`, `SOLANA_TREASURY_SEED`, optional `AI_GATEWAY_API_KEY`) live in the Worker via `wrangler secret`.

Inbound SMS goes through a Cloudflare Queue (bindings in `wrangler.jsonc`). The queues must exist before the first deploy that uses them:

```bash
pnpm wrangler queues create sms-inbound
pnpm wrangler queues create sms-inbound-dlq
```

Texts that still fail after 8 retries land in `sms-inbound-dlq`, which has no consumer. Inspect them in the Cloudflare dashboard under Queues → sms-inbound-dlq. Every inbound text logs JSON lines with `"evt":"sms_inbound"`, a hashed key prefix, the stage, outcome and attempt.

Testnet only. Wallets are held by Dial and encrypted at rest; tranche 2 moves passkey accounts to self-custody.

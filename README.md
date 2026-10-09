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

Commands: `send jeremy $10`, `411 jeremy`, `call me <name>`, `whoami`, `send $5 to +1 555 123 4567`, `request $25 from adam for pizza`, `invoice sam $200 for logo design`, `balance`, `receive`, `withdraw $10 to <address>`, `reclaim`, `no` (decline a request), `upgrade`, `connect agent`, `revoke agents`, `help`.

## For agents

Any MCP client can pay, request or invoice anyone with a phone number. The person still approves every payment from a text.

1. Text `connect agent` to +1 806 607 1387. You get a one-time link and code; the page shows an agent key once.
2. Point your MCP client at `https://text-my-crypto.raspy-thunder-20d2.workers.dev/api/mcp` with `Authorization: Bearer <key>`.
3. Tools: `whoami`, `get_balance`, `get_receive_address`, `resolve_recipient`, `send_payment`, `request_payment`, `create_invoice`, `withdraw`, `get_payment`, `list_payments`.

Money tools create a pending payment, text the payer a code, and return `{ intentId, status: "awaiting_approval", approveUrl }`. Agents poll `get_payment`; there is no tool that approves. Text `revoke agents` to turn off every key. Keys are stored as SHA-256 hashes and rate-limited per key.

Install the skill that teaches an agent all this:

```bash
npx skills add Dial-WTF/text-my-crypto
```

Source: `src/app/api/mcp/route.ts`, `src/lib/agents/`, `skills/dial-operator/`.

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

`pnpm ship` is the gated deploy: lint, typecheck and tests, one build, then **staging** (D1 migrations, deploy, `pnpm smoke --env staging`), and only if the smoke test passes, **production** (D1 migrations, deploy). Pushes to `main` run the same script in `.github/workflows/deploy.yml`, which needs the `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `STAGING_SMS_WEBHOOK_SECRET` repository secrets. `pnpm run deploy` still deploys production directly, skipping the gate.

Runtime secrets (`PAYPHONE_API_KEY`, `SMS_WEBHOOK_SECRET`, `WALLET_ENCRYPTION_KEY`, `SOLANA_TREASURY_SEED`, optional `AI_GATEWAY_API_KEY`, optional `ALERT_PHONE`) live in the Worker: keep them in `.env.production.local` and run `pnpm secrets:push`.

### Staging

`wrangler.jsonc` → `env.staging`: Worker `text-my-crypto-staging` (https://text-my-crypto-staging.raspy-thunder-20d2.workers.dev), D1 `text-my-crypto-staging`, queues `sms-inbound-staging` and `sms-inbound-staging-dlq`, the same testnet chains, and `SMS_MODE=log`, so it never sends a real text. Its secrets are in `.env.staging.local` (`pnpm secrets:push --env staging`).

`pnpm smoke --env staging` drives the real webhook with fictional 555-01XX numbers: a new user texts `hi`, a name, `balance`, `send @<receiver> $1`, the code (expects `Sending…` then `Sent…`), and `wallet` (expects a link). Replies are read from `/api/sms/<secret>/log`, which only exists where `SMS_MODE=log` and only shows 555-01XX numbers. A failure prints the whole transcript. `pnpm smoke --env local` runs it against `pnpm dev`.

### Watchdog

A cron trigger runs `worker.ts`'s `scheduled` handler every minute in production. It calls `/api/sms/<secret>/watchdog`, which checks D1, Payphone auth and every chain's RPC (the same checks as `/health`), inbound texts over a minute old with no reply and no handled mark, and Payphone's inbox for texts over two minutes old that never reached `sms_log`. Problems are texted to `ALERT_PHONE` only, once per problem per 30 minutes, with one all-clear text when they clear (state in the `watchdog_problems` table; dependencies alert on the second failing minute). Each run logs one `"evt":"watchdog"` line. If the app can't answer at all, the worker texts the owner directly. Without `ALERT_PHONE` it only logs.

Inbound SMS goes through a Cloudflare Queue (bindings in `wrangler.jsonc`). The queues must exist before the first deploy that uses them:

```bash
pnpm wrangler queues create sms-inbound
pnpm wrangler queues create sms-inbound-dlq
```

Texts that still fail after 8 retries land in `sms-inbound-dlq`, which has no consumer. Inspect them in the Cloudflare dashboard under Queues → sms-inbound-dlq. Every inbound text logs JSON lines with `"evt":"sms_inbound"`, a hashed key prefix, the stage, outcome and attempt.

Testnet only. Wallets are held by Dial and encrypted at rest; tranche 2 moves passkey accounts to self-custody.

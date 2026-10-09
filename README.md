# Dial operator

Text money to anyone. Text **+1 806 607 1387**, say hi, and the Dial operator handles the rest: send, request, invoice, receive and withdraw USDC by plain SMS. No app, no wallet address. Works on any phone.

Live: https://dialoperator.cc

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
- **Paying someone new.** Their phone number is enough. Funds wait in escrow; only the holder of that number can claim (code texted to it). Unclaimed escrows come back with `reclaim` after 7 days. On Solana the escrow is an on-chain program ([`solana/`](solana/README.md)): it pays the recipient only on the operator's attestation, and after expiry anyone can send the money back to the sender, with or without Dial. On devnet Dial still holds the program's upgrade key; mainnet would put it behind a multisig or freeze the program.
- **Splitting a bill.** `split $30 between @alex @sam on tempo` divides it to the cent (a leftover cent goes to the first person); `split $30 with @alex @sam` counts you in and you pay the others' shares. Up to 10 people. One code approves it, and every share settles in a single Tempo transaction: one TIP-20 transfer-with-memo per person, each memo that share's payment id, with the treasury paying the fee. Tempo runs the calls atomically, so either everyone is paid or nobody is. Someone not on Dial yet gets their share held for them, in the same transaction.
- **Exit anytime.** `withdraw all to <address>`.

Names work like an operator's switchboard: reply with any name ("J. P. Meyer, crypto anarchist" becomes J. P. Meyer, `@jpmeyer`), find people with `411 <name>`, and pay a name: your contacts first, then the directory (one match connects, several ask you to pick, none asks for a number).

Commands: `send jeremy $10`, `split $30 between @alex @sam on tempo`, `411 jeremy`, `call me <name>`, `whoami`, `send $5 to +1 555 123 4567`, `request $25 from adam for pizza`, `invoice sam $200 for logo design`, `balance`, `receive`, `withdraw $10 to <address>`, `reclaim`, `no` (decline a request), `upgrade`, `connect agent`, `revoke agents`, `help`.

## For agents

Any MCP client can pay, request or invoice anyone with a phone number. The person still approves every payment from a text.

1. Text `connect agent` to +1 806 607 1387. You get a one-time link and code; the page shows an agent key once.
2. Point your MCP client at `https://dialoperator.cc/api/mcp` with `Authorization: Bearer <key>`.
3. Tools: `whoami`, `get_balance`, `get_receive_address`, `resolve_recipient`, `send_payment`, `request_payment`, `create_invoice`, `split_payment`, `withdraw`, `get_payment`, `list_payments`.

Money tools create a pending payment, text the payer a code, and return `{ intentId, status: "awaiting_approval", approveUrl }`. Agents poll `get_payment`; there is no tool that approves. Text `revoke agents` to turn off every key. Keys are stored as SHA-256 hashes and rate-limited per key.

Install the skill that teaches an agent all this:

```bash
npx skills add Dial-WTF/text-my-crypto
```

Source: `src/app/api/mcp/route.ts`, `src/lib/agents/`, `skills/dial-operator/`.

## Stack

Next.js 16 on Cloudflare Workers (OpenNext) · D1 · Drizzle · `@solana/kit` · SimpleWebAuthn · AI SDK · Payphone for SMS. TypeScript throughout; Rust (Anchor) for the Solana escrow program in `solana/`. See [docs/ROADMAP.md](docs/ROADMAP.md).

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

### Checks

- `pnpm lint`: ESLint with typescript-eslint's type-checked rules (floating promises, async handlers passed where React expects a plain function, switches that miss a case, conditions that can't be false, `undefined` in a template string).
- `pnpm typecheck`: `tsc`. Needs `cloudflare-env.d.ts`, so run `pnpm cf-typegen` once in a fresh checkout.
- `pnpm deadcode`: knip, for unused files, exports and dependencies.
- `pnpm test:coverage`: the tests, plus a 95% per-file branch-coverage floor on the money paths (`vitest.config.mts` lists them). The suite includes fast-check property tests (`tests/property/`) and a migration check (`tests/db/migrations.test.ts`): every `drizzle/*.sql`, applied in order to an empty database, has to produce exactly `src/lib/db/schema.ts`.
- `pnpm rust:check`: `cargo clippy -D warnings` and `cargo audit` on `solana/`, `contracts/arbitrum-escrow` and `services/zcash-wallet`. Slower, so it isn't part of `pnpm ship`; run it before merging Rust changes. Needs `cargo install cargo-audit --locked`.

## Deploy

`pnpm ship` is the gated deploy: lint, typecheck, deadcode and tests with the coverage floors, one build, then **staging** (D1 migrations, deploy, `pnpm smoke --env staging`), and only if the smoke test passes, **production** (D1 migrations, deploy). Pushes to `main` run the same script in `.github/workflows/deploy.yml`, which needs the `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `STAGING_SMS_WEBHOOK_SECRET` repository secrets. `pnpm run deploy` still deploys production directly, skipping the gate.

Runtime secrets (`PAYPHONE_API_KEY`, `SMS_WEBHOOK_SECRET`, `WALLET_ENCRYPTION_KEY`, `SOLANA_TREASURY_SEED`, optional `AI_GATEWAY_API_KEY`, optional `ALERT_PHONE`) live in the Worker: keep them in `.env.production.local` and run `pnpm secrets:push`.

Production answers on https://dialoperator.cc (a Worker custom domain; `APP_URL`). GET and HEAD requests to `www.dialoperator.cc`, and to pages on the old `text-my-crypto.raspy-thunder-20d2.workers.dev` address, get a 301 to the same path there (`src/lib/canonical-host.ts`). Anything under `/api/` on workers.dev is served where it is: Payphone's inbound webhook, the MCP server and the Actions API keep the address they were given.

### Staging

`wrangler.jsonc` → `env.staging`: Worker `text-my-crypto-staging` (https://text-my-crypto-staging.raspy-thunder-20d2.workers.dev), D1 `text-my-crypto-staging`, queues `sms-inbound-staging` and `sms-inbound-staging-dlq`, the same testnet chains, and `SMS_MODE=log`, so it never sends a real text. Its secrets are in `.env.staging.local` (`pnpm secrets:push --env staging`). It needs no `PAYPHONE_API_KEY`: in log mode the Payphone checks are skipped. Give it its own treasury keys (`node scripts/gen-secrets.mjs`, then fund the printed addresses from the faucets) so smoke runs never spend from, or race nonces with, production's treasury.

`pnpm smoke --env staging` drives the real webhook with fictional 555-01XX numbers: a new user texts `hi`, a name, `balance`, `send @<receiver> $1`, the code (expects `Sending…` then `Sent…`), and `wallet` (expects the wallet link and a code, then signs in with them and checks `/wallet`). Replies are read from `/api/sms/<secret>/log`, which only exists where `SMS_MODE=log` and only shows 555-01XX numbers. A failure prints the whole transcript. `pnpm smoke --env local` runs it against `pnpm dev`.

### Watchdog

A cron trigger runs `worker.ts`'s `scheduled` handler every minute in production. It calls `/api/sms/<secret>/watchdog`, which checks D1, Payphone auth and every chain's RPC (the same checks as `/health`), inbound texts over a minute old with no reply and no handled mark, and Payphone's inbox for texts over two minutes old that never reached `sms_log`. Problems are texted to `ALERT_PHONE` only, at most once per check per 30 minutes even when it flaps, and an alerted problem gets one all-clear after two passing minutes. Texts that leave the 1-hour window unanswered or undelivered close as "aged out", not "Cleared". State lives in the `watchdog_problems` table; dependencies alert on the second failing minute. Each run logs one `"evt":"watchdog"` line. If the app can't answer at all, the worker texts the owner directly from the second failing minute, throttled through the same table; if D1 is down too, it only texts at :00 and :30. Without `ALERT_PHONE` it only logs.

Inbound SMS goes through a Cloudflare Queue (bindings in `wrangler.jsonc`). The queues must exist before the first deploy that uses them:

```bash
pnpm wrangler queues create sms-inbound
pnpm wrangler queues create sms-inbound-dlq
```

Texts that still fail after 8 retries land in `sms-inbound-dlq`, which has no consumer. Inspect them in the Cloudflare dashboard under Queues → sms-inbound-dlq. Every inbound text logs JSON lines with `"evt":"sms_inbound"`, a hashed key prefix, the stage, outcome and attempt.

Testnet only. Wallets are held by Dial and encrypted at rest; tranche 2 moves passkey accounts to self-custody.

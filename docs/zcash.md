# Zcash

Dial sends shielded testnet ZEC (TAZ) between phone numbers. A Worker can't scan the chain or prove a
Zcash transaction, so a small Rust wallet service does that and the Worker calls it over HTTP. Zcash
stays off until one real testnet round-trip has gone through (see "Turning it on").

## What we picked and why

**A small service on librustzcash (`zcash_client_backend` + `zcash_client_sqlite`), syncing from the
public testnet lightwalletd at `testnet.zec.rocks:443`.** Code: `services/zcash-wallet`.

What decided it, as of 2026-10-08:

- **Testnet is on NU7.** It activated at height 4,465,026, and `testnet.zec.rocks` reports consensus
  branch `0x77190ad9`. Only the librustzcash NU7 pre-release crates (`zcash_protocol 0.11.0-pre.0`,
  `zcash_client_backend 0.25.0-pre.1`, `zcash_client_sqlite 0.23.0-pre.1`, from Oct 1 to Oct 6) know
  that branch. Anything on the stable crates builds transactions testnet rejects. The service pins
  the pre-releases exactly, the same way Zallet's NU7 PR does.
- **zcash-devtool** is on the stable crates (0.24 / 0.22), so it can't send on testnet today. Its
  `wallet send` and `init` code was the reference for ours. It also calls itself a dev tool whose
  CLI changes without warning.
- **Zallet** (zcashd's replacement) is the long-term answer, but it is a full-node wallet: it reads
  Zebra's state, so it needs a synced testnet `zebrad` next to it. Its NU7 testnet support is an
  open PR (zcash/zallet#898). Too much to run before Oct 12.
- **zingolib** has no maintained crates.io release (0.0.1) and would mean tracking a git branch
  through the NU7 change.

Public testnet lightwalletd endpoints checked: `testnet.zec.rocks:443` answers (chain `test`,
lightwalletd v0.5.4). `lightwalletd.testnet.electriccoin.co:9067` timed out and
`zcash.mysideoftheweb.com:19067` refused the connection.

## How it works

- **One seed, one account per Dial wallet.** The service holds a single BIP 39 seed. Account 0 is the
  treasury; every user wallet and every escrow is the next ZIP 32 account. All accounts are scanned
  together in one wallet database.
- **Keys stay in the service.** Other chains seal each wallet's private key into D1. Here the service
  needs the viewing key of every account anyway to scan the chain, so it derives spending keys from
  its seed and D1 only stores which account a wallet is (`{"zcashAccount": 7}`, still sealed like
  any other wallet secret). Losing D1 loses nothing on chain; the seed is what to back up.
- **Shielded only.** Addresses are unified addresses with Orchard and Sapling receivers. Sends to
  transparent addresses are refused. Since NU6.3, new shielded value lands in the Ironwood pool and
  change goes there too; the library picks the pools.
- **Memo = payment id.** Every send carries the intent id (`pi_…`) as its encrypted memo, so the
  recipient's wallet, and the ledger, can match a transaction to a payment.
- **Confirmations.** Notes are spendable after one confirmation (testnet blocks are ~75s). A send
  that comes in while the wallet's funds are still unconfirmed waits up to 3 minutes for them instead
  of failing. The treasury keeps its change split into up to 8 notes so signups in a row don't wait
  on each other.
- **Fees.** The sender pays a ZIP 317 fee, 0.0001 TAZ for a normal payment. There is no fee sponsor
  like Tempo's, so:
  - A balance is what the account can send after the fee to spend everything it holds (the service
    computes it from the same proposal a sweep would build).
  - A payment to another Dial wallet carries one fee on top, so the recipient can spend all of it.
  - A payment into an escrow carries two: one for the release and one for the recipient's next send.
    The release sweeps the escrow, so the recipient gets the full amount plus their one fee.
  - A drip carries three fees on top of the dollar amount (two from the adapter, one as a Dial
    recipient). One is held back for the user's own fee, which leaves the two an escrow send carries:
    a new user can send their whole drip to someone not on Dial yet.
  - The bot counts the carried fees before it asks for a code. Enough for the amount but not the
    fees gets "that payment also needs $0.01 (0.0002 TAZ) for network fees… Try a little less."
- **Accounts come from a pool.** Every account shares the service birthday, and importing one makes
  the wallet rescan from there. So the service makes 100 at a time ahead of signups and hands them out
  one by one: a new wallet is instant and never triggers a rescan, and the pool tops up (one rescan)
  when fewer than 10 are left. Giving each account its own recent birthday was tried; the NU7
  pre-release crates then refuse to add a second account ("commitment tree retains checkpoints both
  above and below …").
- **Sends are idempotent.** The service keys every send and drip on (account, recipient, memo). The
  memo is the payment id, and a drip's memo with its recipient is unique too. Asking again returns the
  transaction that already went out and re-broadcasts it. The transaction is built, broadcast and recorded in one database
  transaction: if lightwalletd refuses it, it rolls back and the notes stay spendable. If the
  broadcast gets no answer, the transaction and its record are kept, and the service answers
  `unknown`.
- **Unknown outcomes never read as failed.** When a send or drip gets no answer (timeout, dropped
  connection, 5xx, rate limit) the adapter asks again twice, then throws `SettlementUnknownError`.
  The bot leaves the payment "settling", texts the sender that it may still go through, and the
  minute watchdog re-drives it with the same arguments until it settles or gets a definite no. A
  drip in that state stays taken, so it can't be sent twice. A resume run marks the payment
  "retrying since <time>"; if that run dies, the next one picks it up after 5 minutes.

## Dollars and TAZ

The bot speaks dollars. Testnet ZEC has no price, so Zcash uses a fixed demo rate in the registry
(`usdPerZec: 50`). "$5" is 0.1 TAZ and the network fee is half a cent. Every text, the wallet page,
the pay page and the agent tools say the coin next to the dollars and never call it USDC:

> Send $5 (0.1 TAZ) to @alex on Zcash? Reply 123456 to confirm

Zcash balances are listed per chain and left out of the USDC total. People still type dollars
("send @alex $5 on zcash"); there is no ZEC-denominated command.

## The service API

All routes except `/healthz` need `Authorization: Bearer $ZCASH_SERVICE_TOKEN`.

| Route | Does |
|---|---|
| `GET /healthz` | `{ok, synced}`; behind the Container wrapper, `{ok, running: false}` without waking a sleeping container |
| `GET /v1/status` | chain tip, scanned height, account count |
| `GET /v1/treasury` | account 0's address |
| `POST /v1/accounts` | hands out the next pooled account: `{account, address}` |
| `POST /v1/restore {accounts}` | marks accounts 0..n as handed out and rebuilds them (plus the pool) on a fresh disk; idempotent |
| `GET /v1/balance/:address` | `{account, spendable, total, sendable, synced}`, amounts in zatoshis |
| `POST /v1/send {account, to, zats, memo, sweep, carry, wait}` | `{txid}`; `sweep` sends everything spendable minus the fee; `carry` (1 or 2) fees go on top for a Dial recipient |
| `POST /v1/fund {to, zats, memo, wait}` | send from the treasury |

Sends, drips and new accounts share a limit of 30 a minute (429 `rate_limited`, nothing sent).
Errors are `{error, message}`: 400 `bad_request`, 404 `not_found`, 409 `insufficient_funds`,
422 `rejected` (lightwalletd refused the transaction; nothing moved), 503 `not_synced`, 504 `unknown`
(broadcast got no answer; ask again), 500 `internal` (details only in the service log).

## Hosting

**Cloudflare Container** (`services/zcash-wallet/worker`): a tiny Worker plus a Durable Object that
starts one container (`standard-1`) and proxies to it. Container disk is ephemeral, so the Durable
Object keeps what must outlive a restart. It counts the accounts the service has handed out and
passes `ZCASH_ACCOUNTS` on every start, so a fresh disk rebuilds every account from the seed and
rescans from the shared birthday. It also keeps the txid of every send and drip by the same
(account, recipient, memo) key, and answers a repeat from there, so idempotency survives a fresh
disk too. `sleepAfter` is 24h so the rescan rarely happens. The image runs as a non-root user.
During a rescan the sync loop works on its own database connection, so health checks, balances and
sends aren't stuck behind it; balances answer `synced: false` and the bot treats Zcash as down until
the rescan finishes.

**Or any small host with a disk** (a $5 VM, Fly machine with a volume): run the same image with
`/data` on a volume and the three env vars below. Nothing else changes; point `ZCASH_SERVICE_URL`
at it over HTTPS.

## Setting it up (Jeremy)

1. **Service secrets.** `.env.zcash.local` in the main checkout already has `ZCASH_SEED_PHRASE`,
   `ZCASH_SERVICE_TOKEN` and `ZCASH_BIRTHDAY` (4480374), generated on 2026-10-08. Back it up with the
   other env files: the seed holds the treasury.
2. **Deploy the service** (needs Docker running and Workers Paid for Containers):
   ```
   cd services/zcash-wallet/worker && pnpm install --ignore-workspace
   node ~/.agents/bin/env-guard.mjs run -- pnpm exec wrangler secret put ZCASH_SEED_PHRASE
   node ~/.agents/bin/env-guard.mjs run -- pnpm exec wrangler secret put ZCASH_SERVICE_TOKEN
   node ~/.agents/bin/env-guard.mjs run -- pnpm run deploy
   ```
   `ZCASH_BIRTHDAY` is a var in `worker/wrangler.jsonc`. Check it: `curl https://dial-zcash-wallet.<subdomain>.workers.dev/healthz`.
3. **Fund the treasury with TAZ.** `GET /v1/treasury` gives the address. The faucets listed by ZecHub
   were down on 2026-10-08 (`testnet.zecaucet.com` has no DNS, `faucet.zecpages.com` doesn't answer),
   so ask for TAZ in the Zcash community Discord or forum. A signup drip costs the treasury the drip
   plus up to about 0.0007 TAZ in fees (three carried fees and the treasury's own, which splits its change): 0.02 TAZ at staging's $1, 0.04 TAZ at production's $2. 2 TAZ covers
   about 45 production signups. Raise `usdPerZec` in the registry if TAZ is scarce.
4. **One real round-trip** with the local or deployed service:
   ```
   ZCASH_INT=1 ZCASH_SERVICE_URL=… ZCASH_SERVICE_TOKEN=… pnpm vitest run tests/settlement/zcash.int.test.ts
   ```
   It drips $1 to a new wallet, pays it into a second wallet with a memo, and sweeps that one out to a
   third, about 0.03 TAZ.
5. **Turn it on.** Put `ZCASH_SERVICE_URL` and `ZCASH_SERVICE_TOKEN` in `.env.staging.local` and
   `.env.production.local`, `pnpm secrets:push` (both envs). In `wrangler.jsonc`, append `zcash` to
   production's `CHAINS` (top-level `vars`, today `solana,tempo,ethereum,robinhood`), and add a
   `CHAINS` line to `env.staging`'s `vars` (staging has none, so it runs the default `solana,tempo`):
   staging first, then production. Set `proven: true` on the Zcash testnet registry entry once the live
   test has passed, so the site says "Wired" rather than "Building" while it's off. Then `pnpm ship`. Then flip the landing tile to
   "Live · testnet" once a text has settled there.

## Running it locally

```
cd services/zcash-wallet && cargo build
set -a && . /path/to/main/checkout/.env.zcash.local && set +a
DATA_DIR=/tmp/zwallet PORT=8787 ./target/debug/zcash-wallet
```

`zcash-wallet new-seed` prints a fresh phrase for a new service.

## Limits

- Testnet only; the service hard-codes testnet parameters and the registry has no mainnet entry.
- One wallet process. Sends are serialized behind one lock, and a send that waits for confirmations
  holds a request open for up to 3 minutes.
- Fees are real and come out of TAZ the sender holds. Sending your whole balance to another Dial
  wallet needs one more fee than sending it out of Dial (the carry). Sending to an escrow, someone
  not on Dial yet, needs two more fees (0.0002 TAZ, a cent at the demo rate). When that's short, the
  payment fails up front and nothing moves.
- A broadcast that got no answer is kept as sent. If it never reached the network it expires after
  about 40 blocks, but the payment already shows settled with that txid. This needs a dropped
  broadcast and a lost transaction together, so it's rare. The fix would be to check the txid on chain
  before settling.
- On the single-host option the send ledger lives on the disk only; lose the disk and a retried
  payment could go out twice. Behind the Container wrapper the Durable Object keeps a copy.
- Received memos aren't read back: the service doesn't fetch full transactions after scanning
  compact blocks. Matching works from our side, because we record the txid we sent.

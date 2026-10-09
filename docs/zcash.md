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
  like Tempo's. So balances hold one fee back, drips include one extra fee, and a payment to another
  Dial wallet carries one fee on top. That makes an escrow release pay the recipient the full amount.

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
| `GET /healthz` | `{ok, synced}` |
| `GET /v1/status` | chain tip, scanned height, account count |
| `GET /v1/treasury` | account 0's address |
| `POST /v1/accounts` | next account: `{account, address}` |
| `POST /v1/restore {accounts}` | rebuilds accounts 0..n on a fresh disk (idempotent) |
| `GET /v1/balance/:address` | `{account, spendable, total}` in zatoshis |
| `POST /v1/send {account, to, zats, memo, sweep, wait}` | `{txid}`; `sweep` sends everything spendable minus the fee |
| `POST /v1/fund {to, zats, memo, wait}` | send from the treasury |

Errors are `{error, message}`: 400 `bad_request`, 404 `not_found`, 409 `insufficient_funds`,
503 `not_synced`, 502 `upstream` (lightwalletd rejected the transaction).

## Hosting

**Cloudflare Container** (`services/zcash-wallet/worker`): a tiny Worker plus a Durable Object that
starts one container (`standard-1`) and proxies to it. Container disk is ephemeral, so the Durable
Object counts the accounts the service has handed out and passes `ZCASH_ACCOUNTS` on every start. A
fresh disk rebuilds every account from the seed and rescans from the shared birthday. `sleepAfter`
is 24h so that rescan rarely happens.

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
   plus about 0.0003 TAZ in fees: 0.02 TAZ at staging's $1, 0.04 TAZ at production's $2. 2 TAZ covers
   about 45 production signups. Raise `usdPerZec` in the registry if TAZ is scarce.
4. **One real round-trip** with the local or deployed service:
   ```
   ZCASH_INT=1 ZCASH_SERVICE_URL=… ZCASH_SERVICE_TOKEN=… pnpm vitest run tests/settlement/zcash.int.test.ts
   ```
   It drips $1 to a new wallet, pays it into a second wallet with a memo, and sweeps that one out to a
   third, about 0.03 TAZ.
5. **Turn it on.** Put `ZCASH_SERVICE_URL` and `ZCASH_SERVICE_TOKEN` in `.env.staging.local` and
   `.env.production.local`, `pnpm secrets:push` (both envs), then add `"CHAINS": "solana,tempo,zcash"`
   to the `vars` in `wrangler.jsonc`, top level and `env.staging` (CHAINS isn't set today, so it
   defaults to `solana,tempo`), and `pnpm ship`. Then flip the landing tile to
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
- A Dial wallet that received exactly $X from another Dial wallet can send $X out of Dial but not to
  another Dial wallet (that needs a second fee). The bot reports it as a failed payment; nothing moves.
- Received memos aren't read back: the service doesn't fetch full transactions after scanning
  compact blocks. Matching works from our side, because we record the txid we sent.

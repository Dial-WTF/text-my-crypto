# zcash-wallet

Dial's Zcash testnet wallet service: one seed, one shielded account per Dial wallet, synced from
lightwalletd, called by the Worker over HTTP with a bearer token. `worker/` runs it as a Cloudflare
Container.

Why it exists, the API, hosting, and setup: [docs/zcash.md](../../docs/zcash.md).

Env: `ZCASH_SEED_PHRASE` (24 words), `ZCASH_SERVICE_TOKEN` (32+ chars), `ZCASH_BIRTHDAY` (block height),
optional `LIGHTWALLETD_URL` (default `https://testnet.zec.rocks:443`), `DATA_DIR` (default `/data`),
`PORT` (8080), `ZCASH_ACCOUNTS` (rebuild accounts 0..n on start), `ZCASH_MIN_CONFIRMATIONS` (1).

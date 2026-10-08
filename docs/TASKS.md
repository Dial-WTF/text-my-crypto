# Tasks

Deadline: **Oct 12, 11:59pm PDT** (Colosseum Crypto World's Fair). Owner: **you** = Jeremy, **build** = engineering.
Update this file as things ship. Checked = done and verified.

## Tranche 1 · SMS-first payments on Solana — [PR #1](https://github.com/Dial-WTF/text-my-crypto/pull/1)

- [x] build · SMS bot: signup by name, send / request / invoice / receive / balance / withdraw / reclaim / decline / upgrade
- [x] build · Texted one-time codes on every money movement; passkey required above $20 once added
- [x] build · Contacts ("What's jeremy's number?") and per-payment escrow with claim and reclaim
- [x] build · Solana devnet settlement (USDC, memo, treasury-paid fees, rate-limit retry); devnet tests pass
- [x] build · Landing page, payment receipt + approval page, passkey page; dark / light / matrix themes (matrix default)
- [x] build · "Settles on / Runs on" logo strips with honest Live / Building status
- [x] build · Deployed to Cloudflare (Workers + D1); Payphone line +1 806 607 1387 pointed at production
- [x] build · CI + deploy workflows; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets set
- [x] you · Fund the devnet treasury (SOL + USDC)
- [x] you · First live test: signup by text works on a real phone
- [x] build · Fix what the live test turned up: any name becomes a profile + handle, 411 directory, pay by name
- [x] build · State machines (classify → decide → act), STOP/START/HELP, double-tap and repeat-payment handling, code edge cases — see docs/STATES.md
- [x] build · Durable inbound processing (Cloudflare Queue + retries + dead-letter queue): texts are queued before Payphone gets its 200
- [x] build · Multi-word names ("send my guy $1") and a helpful reply when a payment can't be parsed
- [ ] you · Second live test: send to a second phone, claim, request, 411
- [x] you · Merge PR #1
- [ ] you · Optional: add `AI_GATEWAY_API_KEY` for plain-English understanding

## Prize map (official rules §14)

Solana, Tempo, Hyperliquid, Zcash: $100K each (10 × $10K). Ethereum L1, Base, Arbitrum, Robinhood Chain: $25K each (5 × $5K).
General: $30K grand, 20 × $15K, $5K public goods, $5K university. Track prizes stack with general awards.
Judging (rules §8): functionality and code quality, impact, novelty, UX, **open source**, business plan.

## Tranche 2 · More chains, self-custody, agents

- [x] build · Generic EVM adapter (EIP-3009, treasury pays gas) for HyperEVM, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia; Robinhood wired (needs a test token) → enable each with `EVM_CHAINS` once funded
- [ ] you · Fund EVM treasury `0xcc5583a18a9908b80a20876cd8877048ae792B6f`: gas (Sepolia ETH, Base Sepolia ETH, Arbitrum Sepolia ETH, HyperEVM HYPE) + Circle test USDC on each
- [x] build · Tempo adapter (Moderato testnet, AlphaUSD, memo, treasury pays fees); enabled in production
- [ ] you · One real Tempo payment by text ("send @someone $1 on tempo") → then flip Tempo to Live
- [ ] build · Tempo passkey accounts: passkey is the on-chain signer for upgraded users
- [x] build · MCP server at `/api/mcp` (send / request / invoice / withdraw / balance / payments) with per-user agent keys
- [x] build · Agent skill `skills/dial-operator/SKILL.md`, installable with `npx skills add`
- [ ] build · Solana smart wallet with passkey authority (stretch)

## Tranche 3 · On-chain escrow

- [ ] build · Anchor escrow program on Solana devnet: refund after expiry without Dial, claim with attestor signature
- [ ] build · Switch escrow sends to the program; keep server escrow as fallback
- [ ] build · Zcash shielded sends via a Rust wallet service in a Cloudflare Container (stretch)
- [ ] build · Carrier SIM-swap / number-verification check if an aggregator covers US numbers (stretch)

## Submission (Colosseum portal)

- [ ] you · Confirm eligibility with Colosseum (new product; disclose Payphone and Dial as pre-existing work)
- [ ] you · Ask in Colosseum Discord whether one project can place in multiple ecosystem tracks
- [ ] you · Make the repo public with a license (open source is a judging criterion; also the public goods award)
- [ ] you · Confirm no team member is an employee or contractor of a contest sponsor (rules §3b)
- [ ] you · Weekly 1-minute update video (this week: the live SMS flow)
- [ ] you · Pitch video, 2–3 min: founder-market fit (Dial.Work phone rails), why now, live product, go-to-market
- [ ] you · Demo video, ≤3 min: real phone, real texts, explorer receipt
- [ ] you · Form: chains and tools integrated, team, location, logo, GTM, demand validation, prior-work disclosure
- [ ] build · Help outline the form answers and video scripts (you write the final words)
- [ ] build · Product logo / graphic for the submission

## Growth (traction counts)

- [ ] you · Post "text hi to +1 806 607 1387" to Dial and Payphone users, Superteam, X
- [ ] build · Show live counts on the landing page (done) and keep the treasury topped up for signup drips
- [ ] you · Collect a few real quotes from early users (with permission)

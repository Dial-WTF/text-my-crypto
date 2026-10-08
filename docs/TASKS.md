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
- [ ] you · First live test: text "hi" to +1 806 607 1387, sign up, send to a second phone, claim
- [ ] build · Fix anything the live test turns up
- [ ] you · Merge PR #1 (first deploy from GitHub Actions)
- [ ] you · Optional: add `AI_GATEWAY_API_KEY` for plain-English understanding

## Tranche 2 · More chains, self-custody, agents

- [ ] build · Tempo adapter (Moderato testnet, AlphaUSD, transfer memo) → flip Tempo to Live
- [ ] build · Tempo passkey accounts: passkey is the on-chain signer for upgraded users
- [ ] build · Base adapter (USDC on Base Sepolia) → flip Base to Live
- [ ] build · MCP server at `/api/mcp` (send / request / invoice / balance / payments) with per-user agent keys
- [ ] build · Agent skill `skills/dial-operator/SKILL.md`, installable with `npx skills add`
- [ ] build · Solana smart wallet with passkey authority (stretch)

## Tranche 3 · On-chain escrow

- [ ] build · Anchor escrow program on Solana devnet: refund after expiry without Dial, claim with attestor signature
- [ ] build · Switch escrow sends to the program; keep server escrow as fallback
- [ ] build · Zcash shielded sends via a Rust wallet service in a Cloudflare Container (stretch)
- [ ] build · Carrier SIM-swap / number-verification check if an aggregator covers US numbers (stretch)

## Submission (Colosseum portal)

- [ ] you · Confirm eligibility with Colosseum (new product; disclose Payphone and Dial as pre-existing work)
- [ ] you · Ask in Colosseum Discord whether one project can place in multiple ecosystem tracks
- [ ] you · Repo access: make public, or add hackathon@colosseum.com
- [ ] you · Weekly 1-minute update video (this week: the live SMS flow)
- [ ] you · Pitch video, 2–3 min: founder-market fit, Text My Bits lineage, why now, go-to-market
- [ ] you · Demo video, ≤3 min: real phone, real texts, explorer receipt
- [ ] you · Form: chains and tools integrated, team, location, logo, GTM, demand validation, prior-work disclosure
- [ ] build · Help outline the form answers and video scripts (you write the final words)
- [ ] build · Product logo / graphic for the submission

## Growth (traction counts)

- [ ] you · Post "text hi to +1 806 607 1387" to Dial and Payphone users, Superteam, X
- [ ] build · Show live counts on the landing page (done) and keep the treasury topped up for signup drips
- [ ] you · Collect a few real quotes from early users (with permission)
